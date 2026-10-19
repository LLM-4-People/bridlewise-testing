// @vitest-environment node
/**
 * THE COCKPIT'S HALF OF THE REWIND — one owner, and the send that consumes it.
 *
 * The server half is measured against the real provider request in
 * `tests/prevention/rewind-reaches-provider.test.ts`. This file covers the
 * three things that live only in the browser and cannot be seen from there:
 *
 *   A. `edit & resend` is TWO gestures with the user's typing in between, so
 *      the message being replaced has to survive from the click to the send.
 *      That slot is the one piece of state this feature owns.
 *   B. the send CONSUMES it — the rewind is recorded and the corrected
 *      history reloaded BEFORE the run starts. If it did not, the composer's
 *      words would simply be appended and the original wording would still be
 *      in the context the model reads, which is the defect verbatim.
 *   C. a withdrawn turn does not REPLAY in the flow. The server serves it
 *      (flagged) because a rewind is a recorded event and the record has to
 *      survive it; the conversation surface must nonetheless show the
 *      corrected history rather than both versions side by side.
 *
 * Mutation-verified — each is stated on the case it belongs to.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  armEditAndResend,
  armedEditFor,
  armedRewindConfirm,
  clearArmedEdit,
  consumeArmedEdit,
  restoreWithdrawn,
  rewindAndRerun,
  rewindConversation,
} from "../../src/cockpit/flow/rewind.ts";
import { makeVerbsFor, type VerbContext } from "../../src/cockpit/flow/verbs.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import { clearMessages, messages } from "../../src/state/chat-messages.ts";
import { currentChatId } from "../../src/state/chats.ts";
import { currentRun, resetRunState, setRun } from "../../src/state/run-state.ts";
import { performedActions } from "../../src/state/lens.ts";
import { loadChatHistory } from "../../src/client.ts";
import { resetContextStores } from "../../src/state/reset-all.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";
import type { HistoryPageView } from "../../shared/wire-types.ts";

const CHAT = "chat-rewind-owner";

type Row = Readonly<{ id: string; role: string; content: string; discarded?: boolean }>;

/** A `/history` response carrying exactly these rows. */
function historyBody(rows: readonly Row[], page: HistoryPageView) {
  return {
    chat: {
      id: CHAT,
      projectId: "p1",
      title: "rewound",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      modelId: null,
      pinned: false,
    },
    messages: rows.map((r, i) => ({
      id: r.id,
      chatId: CHAT,
      role: r.role,
      content: r.content,
      createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      modelEventType: null,
      runId: null,
      metadata: null,
      ...(r.discarded === true ? { discarded: true } : {}),
    })),
    toolCalls: [],
    metricsSnapshots: [],
    timelineRefs: [],
    page,
  };
}

/** The wire, stubbed: the block-action POST and the `/history` GET.
 *
 * `runStart` answers POST /api/run/start when provided — the re-run half's
 * door — so an arm can hand back exactly what the fixed server sends for a
 * raced start (the 200 refusal envelope) or an admission. */
function stubWire(
  rows: readonly Row[],
  opts: { runStart?: (body: unknown) => { status: number; body: unknown } } = {},
): {
  actionPosts: () => Array<{ path: string; body: unknown }>;
  runStartPosts: () => Array<{ body: unknown }>;
  order: () => string[];
} {
  const posts: Array<{ path: string; body: unknown }> = [];
  const runStarts: Array<{ body: unknown }> = [];
  const order: string[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (init?.method === "POST" && url.includes("/run/start")) {
      order.push("run-start");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
      runStarts.push({ body });
      if (opts.runStart === undefined) return json({ runId: "run-stub-1" });
      const answer = opts.runStart(body);
      return json(answer.body, answer.status);
    }
    if (init?.method === "POST" && url.includes("/b/run.compose/rewind")) {
      order.push("rewind");
      posts.push({
        path: url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });
      return json({
        data: {
          eventId: "evt-1",
          anchorMessageId: "m-1",
          discardedMessageIds: ["m-1", "m-2"],
          discarded: 2,
          promptForRerun: "the original wording",
        },
        meta: { etag: 'W/"1"', asOf: Date.now() },
      });
    }
    if (init?.method === "POST" && url.includes("/b/run.compose/restore")) {
      order.push("restore");
      posts.push({
        path: url,
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });
      return json({
        data: {
          eventId: "evt-2",
          restoredEventId: "evt-1",
          restoredMessageIds: ["m-1", "m-2"],
          restored: 2,
        },
        meta: { etag: 'W/"2"', asOf: Date.now() },
      });
    }
    if (url.includes("/history")) {
      order.push("history");
      return json(historyBody(rows, wholeConversationPage(rows.length)));
    }
    return json({});
  });
  vi.stubGlobal("fetch", fn);
  return { actionPosts: () => posts, runStartPosts: () => runStarts, order: () => order };
}

beforeEach(() => {
  // The confirm slot is context state (it self-registers into the
  // chat-change reset). Fire the registry the same fire the app does on
  // a conversation switch, so no arm leaks from the previous test.
  resetContextStores();
  clearArmedEdit();
  clearMessages();
  currentChatId.set(CHAT);
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearArmedEdit();
  clearMessages();
  currentChatId.set(null);
});

describe("A. the armed edit — one slot, scoped to its conversation", () => {
  test("nothing is armed until edit & resend arms it", () => {
    expect(armedEditFor(CHAT)).toBeNull();
    armEditAndResend(CHAT, "m-7");
    expect(armedEditFor(CHAT)).toBe("m-7");
  });

  test("an anchor armed in another conversation is never returned for this one", () => {
    // MUTATION: drop the chat-id comparison in `armedEditFor` and this fails.
    // It is the lock that stops a rewind aimed at conversation A firing
    // against conversation B after a switch.
    armEditAndResend("some-other-chat", "m-7");
    expect(armedEditFor(CHAT)).toBeNull();
  });

  test("the slot holds ONE anchor — arming again replaces it", () => {
    armEditAndResend(CHAT, "m-1");
    armEditAndResend(CHAT, "m-2");
    expect(armedEditFor(CHAT)).toBe("m-2");
  });

  test("the flow registers the anchor for the chat-change reset", () => {
    // The chat-id check above is the SECOND lock. The first is that switching
    // conversations drops the anchor outright, through the same registry
    // every snapshot store uses. Asserted at the source because the registry
    // is driven by `currentChatId` inside the app's own wiring.
    const src = read("src/cockpit/flow/rewind.ts");
    expect(src).toContain("registerContextReset");
    expect(src).toMatch(/registerContextReset\([^)]*clearArmedEdit\)/);
  });
});

describe("B. the send consumes the armed edit", () => {
  test("consuming posts the rewind for the armed message, then reloads history", async () => {
    armEditAndResend(CHAT, "m-1");
    const wire = stubWire([{ id: "m-9", role: "user", content: "the correction" }]);

    const outcome = await consumeArmedEdit(CHAT);

    expect(outcome).not.toBeNull();
    expect(outcome!.discarded).toBe(2);
    const posts = wire.actionPosts();
    expect(posts).toHaveLength(1);
    // `at` — the message being REPLACED is the first thing withdrawn. `at` vs
    // `causing-prompt` is the whole difference between replacing your own
    // words and re-running them, so it is asserted, not assumed.
    expect(posts[0]!.body).toEqual({ chatId: CHAT, toMessageId: "m-1", mode: "at" });
    // The rewind lands BEFORE the reload: reloading first would re-hydrate
    // the very turns the rewind is about to withdraw.
    expect(wire.order()).toEqual(["rewind", "history"]);
  });

  test("consuming disarms — a second send does not withdraw a second stretch", async () => {
    armEditAndResend(CHAT, "m-1");
    const wire = stubWire([]);
    await consumeArmedEdit(CHAT);
    // MUTATION: remove `clearArmedEdit()` from `consumeArmedEdit` and this
    // fires a second rewind, withdrawing the reply the FIRST resend just
    // produced — an edit that silently eats the answer to it.
    expect(await consumeArmedEdit(CHAT)).toBeNull();
    expect(wire.actionPosts()).toHaveLength(1);
  });

  test("an ordinary send — nothing armed — posts nothing at all", async () => {
    const wire = stubWire([]);
    expect(await consumeArmedEdit(CHAT)).toBeNull();
    expect(wire.actionPosts()).toHaveLength(0);
  });

  test("the composer's plain-text route consumes it BEFORE the run starts", () => {
    // The order is the whole correctness of `edit & resend`, and it lives in
    // a Svelte-adjacent send path that cannot be driven from here without
    // mocking the run stream itself. So it is read out of the product's
    // source: `consumeArmedEdit` must appear, and it must appear ahead of
    // `beginCockpitRun` in the same branch.
    //
    // MUTATION: move the call below `beginCockpitRun` and this fails.
    const src = read("src/cockpit/flow/composer-router.ts");
    const consume = src.indexOf("consumeArmedEdit(chatId)");
    const run = src.indexOf("beginCockpitRun(ctx.projectId");
    expect(consume, "the send path must consume the armed edit").toBeGreaterThan(-1);
    expect(run, "the send path must still start the run").toBeGreaterThan(-1);
    expect(consume).toBeLessThan(run);
  });
});

describe("E. the rewind SHOWS in the flow as an operator intervention", () => {
  test("it lands in the provenance log the `act` beat is minted from", async () => {
    // A rewind is a thing the operator DID to the run, and the flow already
    // has one representation for that — the `act` beat, added when the user
    // asked to "show when we steer, manipulate context, trim, etc". This is
    // the mechanical link: `ingest.ts::syncActs` mints its beats from
    // `performedActions`, which mirrors the Broker's action ledger, which
    // every block action writes to. Going through `brokerAction` rather than
    // a bare `fetch` is what puts the rewind on that path.
    //
    // MUTATION: replace `brokerAction(...)` in `rewindConversation` with a
    // direct `fetchJson` and no record appears here — the rewind would happen
    // invisibly, which is the one thing an intervention must never do.
    const before = performedActions.get().length;
    armEditAndResend(CHAT, "m-1");
    stubWire([]);
    await consumeArmedEdit(CHAT);

    const fresh = performedActions.get().slice(before);
    const record = fresh.find((r) => r.block === "run.compose" && r.action === "rewind");
    expect(record, "the rewind must be recorded as a performed action").toBeDefined();
    expect(record!.state).toBe("done");
    expect(record!.input).toMatchObject({ chatId: CHAT, toMessageId: "m-1", mode: "at" });
  });

  test("the server DECLARES the words the beat renders — the beat never invents them", () => {
    // `syncActs` looks the action up in the served manifest and renders the
    // declared title/consequence verbatim, or renders the absence. A verb
    // that reached the log without a declaration would print nothing.
    const src = read("server/blocks/compose.ts");
    const rewindDecl = src.slice(src.indexOf("      rewind: {"));
    expect(rewindDecl.slice(0, 1200)).toMatch(/title:\s*"Rewind here"/);
    expect(rewindDecl.slice(0, 1200)).toMatch(/consequence:\s*\n?\s*"[^"]{30,}"/);
  });
});

describe("D. ONE door — the destructive path is gone, not merely unused", () => {
  /**
   * The deleting path, named the ONLY way that cannot be renamed around: by
   * the ENDPOINT it speaks to. A first draft of this guard looked for the
   * identifier `rollbackChat`, and a mutation proved it hollow — reinstating
   * the same call as `purgeChatTail` sailed through. A verb is not its name;
   * it is the door it opens, so both scans below key on `/rollback`.
   */
  const DELETING_ENDPOINT = /["'`][^"'`]*\/rollback["'`]/u;

  function reaching(tree: string, exts: readonly string[]): string[] {
    const offenders: string[] = [];
    for (const file of walk(tree, { exts: [...exts] })) {
      const rel = relpath(file);
      for (const line of read(file).split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (DELETING_ENDPOINT.test(line) || /\brollbackChat\b/.test(line)) {
          offenders.push(`${rel}: ${trimmed}`);
        }
      }
    }
    return offenders;
  }

  test("no surface CALLS the deleting rollback, and none DECLARES it either", () => {
    // `POST /api/chats/:id/rollback` DELETED message rows. While a surface
    // still called it, the product held two implementations of one verb with
    // opposite consequences — a rewind that records and a rollback that
    // erases — and which one a user got depended on which button they found.
    //
    // THE EARLIER RATCHET STOPPED ONE STEP SHORT, and this is the correction.
    // It exempted `client.ts` on the reasoning that the module "DECLARES it
    // (the endpoint still exists)". The endpoint does NOT still exist: the
    // route was removed with the deleting path, so `rollbackChat` was a
    // client call aimed at a 404, kept alive by nothing but this exemption
    // and the write inventory that listed it. That is exactly how
    // `deleteMessagesAfter` survived — a destructive capability with zero
    // production callers, held up by its own tests. So the declaration goes
    // too, and the scan no longer exempts the file that held it.
    //
    // MUTATION: reinstate the call under ANY name and this fails — the scan
    // keys on the endpoint, so a rename does not escape it.
    const offenders = reaching("src", [".ts", ".svelte"]);
    expect(
      offenders,
      `these still reach the deleting rollback:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("no route answers the deleting rollback either — the endpoint is gone", () => {
    // The client half being gone is only half the claim. A server that still
    // served `POST /chats/:id/rollback` would be a door with no handle on it,
    // reachable by anything that can make an HTTP request.
    const offenders = reaching("server", [".ts"]);
    expect(offenders, `a rollback route is still registered:\n${offenders.join("\n")}`).toEqual([]);
  });

  test("the scans would catch a caller — they are not passing by finding nothing", () => {
    // Both scans return an empty list, which is also what a broken scan
    // returns. This proves each pattern matches the thing it looks for.
    expect(DELETING_ENDPOINT.test('  await fetchJson("/chats/x/rollback", { method: "POST" });')).toBe(true);
    expect(DELETING_ENDPOINT.test('  router.post("/api/chats/:id/rollback", h);')).toBe(true);
    // …including under a name nobody has thought of yet.
    expect(DELETING_ENDPOINT.test('  return purge(`/chats/${id}/rollback`);')).toBe(true);
    // …and that both trees are genuinely being walked.
    expect(walk("src", { exts: [".ts", ".svelte"] }).length).toBeGreaterThan(100);
    expect(walk("server", { exts: [".ts"] }).length).toBeGreaterThan(20);
  });
});

describe("C. a withdrawn turn does not replay in the conversation", () => {
  test("rows the server flags as withdrawn are not hydrated into the transcript", async () => {
    // MUTATION: drop the `m.discarded !== true` filter in
    // `client.ts::messagesFromRows` and the transcript holds BOTH the
    // withdrawn turn and its replacement — the doubling the user reported,
    // reproduced on the reading side.
    stubWire([
      { id: "m-1", role: "user", content: "delete the databse", discarded: true },
      { id: "m-2", role: "assistant", content: "I could not find it", discarded: true },
      { id: "m-3", role: "user", content: "delete the database" },
      { id: "m-4", role: "assistant", content: "done" },
    ]);

    await loadChatHistory(CHAT);

    const held = messages.get();
    expect(held.map((m) => m.content)).toEqual(["delete the database", "done"]);
    expect(held.some((m) => m.content.includes("databse"))).toBe(false);
  });

  test("a conversation with no rewind loses nothing — the filter is not a blanket", async () => {
    // The mirror. A filter that dropped every row would pass the case above
    // and empty every conversation in the product.
    stubWire([
      { id: "m-1", role: "user", content: "still here" },
      { id: "m-2", role: "assistant", content: "still here too" },
    ]);

    await loadChatHistory(CHAT);

    expect(messages.get().map((m) => m.content)).toEqual(["still here", "still here too"]);
  });
});

describe("F. the rewind door refuses while this conversation's run is LIVE", () => {
  // `retry`, `edit & resend` and `rewind here` all pass ONE door, and that
  // door is closed while a run is streaming the same conversation: withdrawing
  // turns a live run is still reading corrupts the very next request it
  // builds, and a rewind-then-rerun would ALSO start the second concurrent
  // run in one conversation. Steering is the live-run door for words; the
  // rewind doors wait. The guard lives at the operation (not the verb
  // factory) because liveness changes after verbs are minted.
  beforeEach(() => {
    resetRunState();
  });
  afterEach(() => {
    resetRunState();
  });

  const liveRun = (): void => {
    setRun({
      runId: "run-live",
      status: "running",
      startedAt: Date.now(),
      modelLabel: null,
      projectId: "p1",
    });
  };

  test("a rewind under a live run is refused with its sentence and posts nothing", async () => {
    const wire = stubWire([
      { id: "m-1", role: "user", content: "old" },
      { id: "m-2", role: "assistant", content: "done" },
    ]);
    liveRun();
    await expect(rewindConversation(CHAT, "m-2", "at")).rejects.toMatchObject({
      code: "chat_run_live",
    });
    // Refused at the DOOR: the rewind block action never reached the wire.
    expect(wire.actionPosts()).toEqual([]);
  });

  test("the refusal is the honest sentence, naming steering as the live-run door", async () => {
    stubWire([]);
    liveRun();
    const caught = await rewindConversation(CHAT, "m-2", "at").catch((err: unknown) => err);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("a run is still live");
    expect(message).toContain("steering reaches it now");
  });

  test("once the run settles the same rewind runs — the door is live-run-only", async () => {
    const wire = stubWire([
      { id: "m-1", role: "user", content: "old" },
      { id: "m-2", role: "assistant", content: "done" },
    ]);
    setRun({
      runId: "run-done",
      status: "done",
      startedAt: Date.now(),
      modelLabel: null,
      projectId: "p1",
    });
    // THE TWO-PRESS CONFIRM (UIE-039): the first press arms and states
    // what will go; only the second performs. The first press is caught
    // and its sentence asserted in the confirm describe below — here the
    // pair is just the shape the settled arm enters with.
    await rewindConversation(CHAT, "m-2", "at").catch(() => undefined);
    await expect(rewindConversation(CHAT, "m-2", "at")).resolves.toBeDefined();
    expect(wire.actionPosts()).toHaveLength(1);
  });
});

// ── G. the re-run half — where its refusal speaks ──────────────────────────
//
// `retry` is a rewind THEN a re-run, and the rewind withdraws the very beat
// the pressed verb was rendered on — so the verb's own failure span (the
// `role="alert"` beside the control) is destroyed before the re-run can fail.
// Measured live (UIE-014): a raced start's 428 sentence rode the wire and no
// surface carried it. The re-run's failures must speak on the SHELL'S HINT
// LINE, which survives the rewind.
//
//   MUTATION: `rewindAndRerun` swallowing the re-run failure without the
//   sink → the first arm fails (nothing speaks, nothing rethrows).
//   MUTATION: speaking the REWIND half's failure through the sink too → the
//   third arm fails (the verb's own span is still alive there and would say
//   it twice).
describe("G. the re-run half speaks where the rewind has not withdrawn", () => {
  // `openRunStream` (the success path) constructs an EventSource; the node
  // environment has none, and a success arm needs the stream to exist.
  class StubEventSource {
    addEventListener(): void {}
    close(): void {}
  }

  /** The exact body the fixed server sends for a raced start: the 428 as
   * data inside a 200, reconstructed into the typed ClientError by the
   * fetch door (`blockRefusalOf`). */
  const runStartRefused = (): { status: number; body: unknown } => ({
    status: 200,
    body: {
      refusal: {
        code: "chat_run_live",
        message:
          "a run is already live in this conversation — steer it with your next message, or let it settle before starting another",
        status: 428,
      },
    },
  });

  beforeEach(() => {
    vi.stubGlobal("EventSource", StubEventSource);
    resetRunState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRunState();
  });

  test("a refused re-run speaks on the sink — the server's sentence, and nothing claims a run started", async () => {
    stubWire([], { runStart: runStartRefused });
    const spoken: string[] = [];

    // The two-press confirm's first press arms the withdrawal.
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
      onRerunFailure: (sentence) => spoken.push(sentence),
    }).catch(() => undefined);
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
      onRerunFailure: (sentence) => spoken.push(sentence),
    });

    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toContain("a run is already live");
    expect(spoken[0]).toContain("steer it");
    // The refusal started nothing: no run view exists to render as live.
    expect(currentRun.get()).toBeNull();
    // And it PERSISTED nothing: the optimistic re-send is taken back at the
    // door that raised it, so no client-only duplicate of the reader's words
    // lingers in the transcript (a phantom the next reload would erase
    // while the live view kept claiming it). The words are not lost — the
    // ORIGINAL row still stands in the served history; a re-run never
    // withdraws it.
    expect(messages.get().map((m) => m.content)).not.toContain("the original wording");
  });

  test("the re-send carries the RECORDED prompt the rewind handed back", async () => {
    const wire = stubWire([], { runStart: runStartRefused });

    // The confirm's first press arms; the second performs the pair.
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
      onRerunFailure: () => {},
    }).catch(() => undefined);
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
      onRerunFailure: () => {},
    });

    expect(wire.runStartPosts()).toHaveLength(1);
    expect(wire.runStartPosts()[0]!.body).toMatchObject({
      projectId: "p1",
      chatId: CHAT,
      prompt: "the original wording",
    });
  });

  test("with no sink the refused re-run RETHROWS — the caller's local surface is the fallback", async () => {
    stubWire([], { runStart: runStartRefused });

    // The confirm's first press arms; the second performs the pair and
    // meets the refusal, which — with no sink — must rethrow.
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
    }).catch(() => undefined);
    await expect(
      rewindAndRerun({ projectId: "p1", chatId: CHAT, toMessageId: "m-2", mode: "causing-prompt" }),
    ).rejects.toMatchObject({ code: "chat_run_live" });
  });

  test("a failure of the REWIND half rethrows and does not reach the sink — that beat still exists to say it", async () => {
    stubWire([]);
    setRun({
      runId: "run-live",
      status: "running",
      startedAt: Date.now(),
      modelLabel: null,
      projectId: "p1",
    });
    const spoken: string[] = [];

    await expect(
      rewindAndRerun({
        projectId: "p1",
        chatId: CHAT,
        toMessageId: "m-2",
        mode: "causing-prompt",
        onRerunFailure: (sentence) => spoken.push(sentence),
      }),
    ).rejects.toMatchObject({ code: "chat_run_live" });
    expect(spoken).toEqual([]);
  });

  test("an admitted re-run speaks nothing and claims its run", async () => {
    stubWire([]);
    const spoken: string[] = [];

    // The confirm's first press arms; the second performs the pair.
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
      onRerunFailure: (sentence) => spoken.push(sentence),
    }).catch(() => undefined);
    await rewindAndRerun({
      projectId: "p1",
      chatId: CHAT,
      toMessageId: "m-2",
      mode: "causing-prompt",
      onRerunFailure: (sentence) => spoken.push(sentence),
    });

    expect(spoken).toEqual([]);
    expect(currentRun.get()?.runId).toBe("run-stub-1");
  });
});

// ── F. the two-press confirm — a withdrawal is never one press (UIE-039) ──
//
//   Measured live: ONE press of `rewind here` withdrew 165 messages — the
//   whole conversation — with no confirm and no way back. The confirm is
//   the custody undo's shape, at the one choke all three rewind labels
//   cross: the first press arms and SAYS (the sentence renders beside the
//   verb), the second inside REWIND_CONFIRM_WINDOW_MS performs.
//
//   MUTATION: perform on the first press (drop the confirm branch) → the
//   first arm fails (the press resolves, nothing thrown).
//   MUTATION: never expire the arm (drop the window check) → the expiry
//   arm fails (the stale press performs).
describe("F. the two-press confirm — a withdrawal is never one press", () => {
  test("the first press REFUSES with the honest sentence and withdraws nothing", async () => {
    const wire = stubWire([
      { id: "m-1", role: "user", content: "old" },
      { id: "m-2", role: "assistant", content: "done" },
    ]);

    const caught = await rewindConversation(CHAT, "m-2", "at").catch((err: unknown) => err);

    expect(caught).toMatchObject({ code: "rewind_confirm" });
    const message = caught instanceof Error ? caught.message : String(caught);
    // The sentence names what goes, demands the second press, and — the
    // honest part — names the way back.
    expect(message).toContain("press again");
    expect(message).toContain("restore from here");
    // Refused BEFORE the wire: nothing was withdrawn by a first press.
    expect(wire.actionPosts()).toEqual([]);
  });

  test("the second press within the window performs the withdrawal", async () => {
    const wire = stubWire([
      { id: "m-1", role: "user", content: "old" },
      { id: "m-2", role: "assistant", content: "done" },
    ]);

    await rewindConversation(CHAT, "m-2", "at").catch(() => undefined);
    const outcome = await rewindConversation(CHAT, "m-2", "at");

    expect(outcome.discarded).toBe(2);
    expect(wire.actionPosts()).toHaveLength(1);
    // And the confirm is SPENT: a later press of the same verb starts a
    // fresh confirm rather than inheriting a satisfied one.
    await expect(rewindConversation(CHAT, "m-2", "at")).rejects.toMatchObject({
      code: "rewind_confirm",
    });
  });

  test("the arm EXPIRES — a press after the window arms afresh, never performs", async () => {
    vi.useFakeTimers();
    try {
      const wire = stubWire([]);
      await rewindConversation(CHAT, "m-2", "at").catch(() => undefined);

      // Ten seconds is the window; past it the earlier arm is stale and
      // the press RE-ARMS instead of performing. A reader returning to the
      // verb after a distraction must not find their absence had pressed
      // it for them.
      vi.setSystemTime(Date.now() + 10_001);
      await expect(rewindConversation(CHAT, "m-2", "at")).rejects.toMatchObject({
        code: "rewind_confirm",
      });
      expect(wire.actionPosts()).toEqual([]);

      // Within the window the pair still performs — freshness, not a lock.
      const outcome = await rewindConversation(CHAT, "m-2", "at");
      expect(outcome.discarded).toBe(2);
      expect(wire.actionPosts()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("the arm is TARGET-EXACT — a different anchor or mode never inherits it", async () => {
    const wire = stubWire([]);
    await rewindConversation(CHAT, "m-2", "at").catch(() => undefined);

    // A different anchor is a different withdrawal: its first press arms
    // (and REPLACES the pending arm — one destructive intent at a time,
    // the one "press again" refers to), never performs.
    await expect(rewindConversation(CHAT, "m-3", "at")).rejects.toMatchObject({
      code: "rewind_confirm",
    });
    expect(wire.actionPosts()).toEqual([]);

    // And the replaced target no longer has a live arm either.
    await expect(rewindConversation(CHAT, "m-2", "at")).rejects.toMatchObject({
      code: "rewind_confirm",
    });
    expect(wire.actionPosts()).toEqual([]);

    // `at` and `causing-prompt` on the same turn are different withdrawals
    // too — the mode is part of the key.
    await expect(rewindConversation(CHAT, "m-3", "causing-prompt")).rejects.toMatchObject({
      code: "rewind_confirm",
    });
    expect(wire.actionPosts()).toEqual([]);
  });

  test("the confirm names the arm it speaks for, and the slot's moves are observable (UIE-043)", async () => {
    // THE FACE'S BINDING, store half. The confirm sentence renders on the
    // Verb control that caught the throw, and its lifetime must FOLLOW the
    // arm — one slot, one rendered face. Before the fix, a retarget left
    // the FIRST target's "press again" standing beside the second's: two
    // faces for one arm, and pressing the stale one re-armed rather than
    // performed (safe, but untrue copy). The thrown error carries the
    // arm's key and the slot is an observable atom — the rendered-face arm
    // (tests/cockpit/rewind-confirm-face.test.ts) drives exactly this
    // contract through the component.
    const wire = stubWire([]);
    const pressA = await rewindConversation(CHAT, "m-2", "at").catch((err: unknown) => err);
    expect(pressA).toMatchObject({ code: "rewind_confirm" });
    const keyA = (pressA as { confirmKey?: string }).confirmKey;
    expect(keyA, "the confirm failure names the arm it speaks for").toBeDefined();
    expect(armedRewindConfirm.get()?.key, "the slot holds the armed target's key").toBe(keyA);

    // RETARGET: B's press replaces the arm, and both keys move with it.
    const pressB = await rewindConversation(CHAT, "m-3", "at").catch((err: unknown) => err);
    const keyB = (pressB as { confirmKey?: string }).confirmKey;
    expect(keyB).toBeDefined();
    expect(keyB, "a different target arms a different key").not.toBe(keyA);
    expect(armedRewindConfirm.get()?.key, "the slot now holds B's key alone — one arm").toBe(keyB);
    expect(wire.actionPosts(), "a retarget performs nothing").toEqual([]);

    // The perform consumes the slot — the face's lifetime is the arm's.
    await rewindConversation(CHAT, "m-3", "at");
    expect(armedRewindConfirm.get(), "a performed arm is gone, and every face clears with it").toBeNull();
    expect(wire.actionPosts()).toHaveLength(1);
  });

  test("the conversation change drops a pending arm — a stale confirm never fires elsewhere", async () => {
    stubWire([]);
    await rewindConversation(CHAT, "m-2", "at").catch(() => undefined);

    resetContextStores();

    await expect(rewindConversation(CHAT, "m-2", "at")).rejects.toMatchObject({
      code: "rewind_confirm",
    });
  });

  test("`edit & resend` is ONE confirm covering the whole replace — the send is the second press", async () => {
    // The verb's press is the FIRST gesture: it arms the replacement and
    // states what the send will take back, throwing the same
    // `rewind_confirm` every other rewind label confirms with. The send
    // consumes the arm (`alreadyArmed`) — a second sentence for the same
    // one correction would be a nag, and a nagged reader stops reading
    // confirms at all.
    const wire = stubWire([
      { id: "m-9", role: "user", content: "the correction" },
    ]);
    const prefilled: string[] = [];
    const ctx: VerbContext = {
      chatId: CHAT,
      projectId: "p1",
      toggleExpand: () => {},
      prefillComposer: (text: string) => prefilled.push(text),
      hint: null,
      userPromptBefore: () => "the original wording",
    };
    const beat: Beat = {
      id: "b-1",
      kind: "turn",
      parentId: null,
      turnIndex: 0,
      at: 1,
      abnormal: false,
      bleed: true,
      verbs: [],
      turn: { who: "you", text: "the original wording", streaming: false },
    };
    const verbs = makeVerbsFor(ctx)(beat);
    const editVerb = verbs.find((v) => /resend/i.test(v.label));
    expect(editVerb, "the turn beat must carry the edit & resend verb").toBeDefined();

    // The verb's `run` throws SYNCHRONOUSLY (the component's try/catch —
    // the same one every verb's failure lands in — catches sync throws
    // too); the promise wrap only moves the throw where the assertion
    // can see it.
    const caught = await Promise.resolve()
      .then(() => editVerb!.run!())
      .catch((err: unknown) => err);
    expect(caught).toMatchObject({ code: "rewind_confirm" });
    expect(prefilled).toEqual(["the original wording"]);
    // The arm happened — the sentence states the replace — but nothing was
    // withdrawn yet: the send has not happened.
    expect(wire.actionPosts()).toEqual([]);

    // The send performs with NO second confirm.
    const outcome = await consumeArmedEdit(CHAT);
    expect(outcome!.discarded).toBe(2);
    expect(wire.actionPosts()).toHaveLength(1);
  });
});

// ── H. the restore door — a withdrawal is reversible, and the record says so ─
//
//   The server half (the ledger reversal, the re-served stretch) is measured
//   against the real store in `tests/prevention/rewind-reaches-provider.test.ts`.
//   This half is the BROWSER's: the door is reachable from the withdrawn
//   region's own beat, and it lands.
//
//   MUTATION: unwire the restore verb (label it disabled, or drop the
//   eventVerbs case) → the first arm fails (no reachable door).
//   MUTATION: `restoreWithdrawn` skipping the reload → the second arm
//   fails (the order loses its "history").
describe("H. the restore door — a withdrawal is reversible, and the record says so", () => {
  test("a rewind event beat carries the `restore from here` verb — wired, on the recorded withdrawal", () => {
    const ctx: VerbContext = {
      chatId: CHAT,
      projectId: "p1",
      toggleExpand: () => {},
      prefillComposer: () => {},
      hint: null,
      userPromptBefore: () => null,
    };
    const regionBeat: Beat = {
      id: "b-region",
      kind: "event",
      parentId: null,
      turnIndex: 0,
      at: 2,
      abnormal: false,
      bleed: true,
      verbs: [],
      event: {
        eventKind: "rewind",
        text: "2 messages taken back from here — the record keeps them; restore from here brings them back",
        eventId: "evt-1",
      },
    };

    const verbs = makeVerbsFor(ctx)(regionBeat);
    const restoreVerb = verbs.find((v) => v.id === "run.compose/restore");

    expect(restoreVerb, "the withdrawal's own beat must carry the door").toBeDefined();
    expect(restoreVerb!.wired, "the door is wired — it runs, it is not disabled").toBe(true);
    expect(restoreVerb!.reason).toBeUndefined();
    expect(typeof restoreVerb!.run).toBe("function");

    // An honest scoping: a NON-rewind event (a validation, a client error)
    // is not a withdrawal and must not offer a restore that would refuse.
    const otherBeat: Beat = {
      ...regionBeat,
      event: { eventKind: "validation", text: "a gate check passed", eventId: "evt-9" },
    };
    expect(makeVerbsFor(ctx)(otherBeat).find((v) => v.id === "run.compose/restore")).toBeUndefined();
  });

  test("`restoreWithdrawn` posts the RECORDED withdrawal's id, then reloads", async () => {
    const wire = stubWire([]);

    const outcome = await restoreWithdrawn(CHAT, "evt-1");

    expect(outcome.restored).toBe(2);
    expect(outcome.restoredEventId).toBe("evt-1");
    const posts = wire.actionPosts();
    expect(posts).toHaveLength(1);
    // The caller supplies the WITHDRAWAL's ledger address — never the ids
    // to bring back — so the door can only ever reverse exactly what one
    // recorded rewind took.
    expect(posts[0]!.body).toEqual({ chatId: CHAT, eventId: "evt-1" });
    // The restore lands BEFORE the reload, the same order the rewind obeys.
    expect(wire.order()).toEqual(["restore", "history"]);
  });

  test("a restore under a live run is refused with its sentence and posts nothing", async () => {
    const wire = stubWire([]);
    setRun({
      runId: "run-live",
      status: "running",
      startedAt: Date.now(),
      modelLabel: null,
      projectId: "p1",
    });

    await expect(restoreWithdrawn(CHAT, "evt-1")).rejects.toMatchObject({
      code: "chat_run_live",
    });
    expect(wire.actionPosts()).toEqual([]);
  });
});
