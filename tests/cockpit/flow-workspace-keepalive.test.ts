// @vitest-environment jsdom
/**
 * PER-WORKSPACE FLOW KEEP-ALIVE — a tab switch is an assignment, not a rebuild.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * One Flow component serves N workspaces, and every piece of its data layer
 * was single-tenant: one beat array, one ingest cursor, one height index, one
 * desk-line slot. Clicking a tab therefore did not restore a conversation, it
 * RE-INGESTED one — `syncMessages` saw the incoming transcript disagree with
 * the outgoing cursor, `rebuild()` fired, `clearLog()` emptied the array, and
 * the whole conversation was minted again from scratch. Visibly: a blank flow
 * that refills.
 *
 * Worse than slow, it was WRONG in one case: `state/chat-messages.ts` holds
 * exactly one transcript for the whole page, so a run streaming into a
 * background workspace writes its words into the FOREGROUND workspace's
 * transcript — another conversation's model output, appended to the one you
 * are reading, before the flow ever gets a say.
 *
 * ── WHAT IS PINNED HERE ───────────────────────────────────────────────────
 *
 * Every claim is about which log a beat lands in and what survives a switch.
 * Nothing is rendered; the component's half (the four view locals and the
 * height index) is `flow-workspace-view.test.ts`.
 *
 * Each guard is followed by a MUTATION test that transcribes the code as it
 * was and shows the same inputs failing — because "switching keeps the log"
 * is the kind of claim a test can pass by accident (an empty log is also an
 * unchanged log), and only the mutation says which behaviour is doing it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  activateLog,
  appendBeat,
  beatById,
  beatCount,
  clearLog,
  DEFAULT_LOG_ID,
  displayedLogId,
  dropLog,
  logIsReloading,
  logVersion,
  protectLog,
  resetAllLogs,
  unprotectLog,
  warmLogIds,
  withLog,
} from "../../src/cockpit/flow/log.ts";
import { MAX_WARM_LOGS, BACKGROUND_BEAT_BUDGET } from "../../src/cockpit/flow/flow-config.ts";
import {
  activeWorkspaceForRuns,
  applyActiveWorkspace,
  hasLiveRun,
  isParked,
  liveRuns,
  noteRunEnded,
  noteRunStarted,
  resetRunOwnership,
  soleLiveRun,
} from "../../src/cockpit/flow/run-ownership.ts";
import {
  forgetIngestState,
  resetIngest,
  startIngest,
} from "../../src/cockpit/flow/ingest.ts";
import {
  appendMessage,
  clearMessages,
  setMessages,
  type ChatMessage,
} from "../../src/state/chat-messages.ts";
import { currentChatId, selectChat } from "../../src/state/chats.ts";
import {
  activateWorkspace,
  openWorkspace,
  resetWorkspaces,
  activeWorkspaceId,
} from "../../src/state/workspaces.ts";
import {
  deskLine,
  dismissalRecord,
  proposeDeskLine,
  recordDismissal,
  resetAdmission,
} from "../../src/cockpit/computer/admission.ts";
import type { Beat, FindingBody } from "../../src/cockpit/flow/types.ts";

// ── Fixtures ───────────────────────────────────────────────────────────────

function beat(id: string): Beat {
  return {
    id,
    kind: "event",
    parentId: null,
    turnIndex: 0,
    at: 1000,
    abnormal: false,
    bleed: true,
    verbs: [],
    event: { eventKind: "steering", text: id },
  };
}

let msgSeq = 0;
function userMsg(text: string, id?: string): ChatMessage {
  msgSeq += 1;
  return {
    id: id ?? `db-u-${msgSeq}`,
    role: "user",
    content: text,
    timestamp: 1_700_000_000_000 + msgSeq,
  } as ChatMessage;
}

function assistantMsg(text: string, id?: string): ChatMessage {
  msgSeq += 1;
  return {
    id: id ?? `db-a-${msgSeq}`,
    role: "assistant",
    content: text,
    timestamp: 1_700_000_000_000 + msgSeq,
  } as ChatMessage;
}

function finding(sentence: string): FindingBody {
  return {
    findingKind: "context-projection",
    sentence,
    derivation: { sources: ["chat"], steps: [], asOf: 1 },
  } as unknown as FindingBody;
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  resetIngest();
  resetRunOwnership();
  resetAllLogs();
  resetAdmission();
  clearMessages();
  selectChat(null);
  msgSeq = 0;
});

afterEach(() => {
  resetIngest();
  resetRunOwnership();
  resetAllLogs();
  resetAdmission();
  clearMessages();
});

// ── A. The log is a map of logs, and only one is on screen ─────────────────

describe("the beat log holds one log per workspace", () => {
  test("activating swaps what the accessors see; neither log is emptied", () => {
    activateLog("ws-a");
    appendBeat(beat("a-1"));
    appendBeat(beat("a-2"));
    const heldA = beatById("a-1");

    activateLog("ws-b");
    expect(beatCount(), "a workspace opened for the first time starts empty").toBe(0);
    appendBeat(beat("b-1"));
    expect(beatCount()).toBe(1);

    activateLog("ws-a");
    expect(beatCount(), "returning restores every beat, not a rebuild of them").toBe(2);
    expect(
      beatById("a-1"),
      "the SAME beat object — a rebuild would have minted a new one",
    ).toBe(heldA);
    expect([...warmLogIds()].sort()).toEqual(["ws-a", "ws-b"]);
  });

  test("clearing the displayed log leaves every other log untouched", () => {
    activateLog("ws-a");
    appendBeat(beat("a-1"));
    activateLog("ws-b");
    appendBeat(beat("b-1"));
    clearLog();
    expect(beatCount(), "the displayed log is the one that clears").toBe(0);
    activateLog("ws-a");
    expect(beatCount(), "a clear must not reach across workspaces").toBe(1);
  });

  test("a background write reaches its own log and does not wake the displayed one", () => {
    activateLog("ws-a");
    appendBeat(beat("a-1"));
    const before = logVersion.get();

    withLog("ws-b", () => appendBeat(beat("b-1")));

    expect(logVersion.get(), "nothing on screen changed, so nothing re-reads").toBe(before);
    expect(displayedLogId()).toBe("ws-a");
    expect(beatCount(), "the displayed log did not receive the background beat").toBe(1);
    activateLog("ws-b");
    expect(beatById("b-1"), "the background beat landed in the log it was addressed to").toBeDefined();
  });

  test("mutation: a single shared array cannot answer for two workspaces at once", () => {
    // The log as it was — one array, one index — replayed against the same
    // two-workspace sequence. There is nowhere for A's beats to be.
    const beats: Beat[] = [];
    beats.push(beat("a-1"), beat("a-2"));
    // "switching" was a clear + re-sync, because the transcript diverged.
    beats.length = 0;
    beats.push(beat("b-1"));
    // Coming back:
    beats.length = 0;
    expect(
      beats.length,
      "with one array, returning to a workspace can only start from nothing",
    ).toBe(0);
  });
});

// ── B. The memory budget, and the honesty it owes ──────────────────────────

describe("warm logs are bounded, and an evicted one says so", () => {
  test("beyond the cap the least-recently-active log is released, never the one on screen", () => {
    for (let i = 0; i <= MAX_WARM_LOGS; i += 1) {
      activateLog(`ws-${i}`);
      appendBeat(beat(`b-${i}`));
    }
    const warm = warmLogIds();
    expect(warm.length, "the cap holds").toBe(MAX_WARM_LOGS);
    expect(warm, "the oldest activation is the one released").not.toContain("ws-0");
    expect(warm, "the log on screen is never a candidate").toContain(`ws-${MAX_WARM_LOGS}`);
  });

  test("beyond the beat budget the oldest background logs are released", () => {
    // Two background logs, each over half the budget, plus a third on screen.
    const bulk = Math.ceil(BACKGROUND_BEAT_BUDGET * 0.6);
    activateLog("ws-old");
    for (let i = 0; i < bulk; i += 1) appendBeat(beat(`old-${i}`));
    activateLog("ws-new");
    for (let i = 0; i < bulk; i += 1) appendBeat(beat(`new-${i}`));
    activateLog("ws-front");
    appendBeat(beat("front-1"));

    expect(
      warmLogIds(),
      "two logs of 0.6× the budget cannot both stay warm behind a third",
    ).not.toContain("ws-old");
    expect(warmLogIds(), "the newer background log fits inside the budget").toContain("ws-new");
  });

  test("an evicted log reports RELOADING; a genuinely empty conversation does not", () => {
    activateLog("ws-victim");
    appendBeat(beat("v-1"));
    for (let i = 0; i < MAX_WARM_LOGS + 1; i += 1) {
      activateLog(`ws-filler-${i}`);
      appendBeat(beat(`f-${i}`));
    }
    activateLog("ws-victim");
    expect(beatCount(), "its beats were released").toBe(0);
    expect(
      logIsReloading(),
      "zero beats after an eviction is a RELOAD in progress, and the surface must say so " +
        "rather than print 'nothing recorded in this conversation yet' over a real conversation",
    ).toBe(true);

    activateLog("ws-brand-new");
    expect(
      logIsReloading(),
      "zero beats in a conversation nothing was ever recorded in is the opposite claim",
    ).toBe(false);
  });

  test("a log a run is writing into is protected from the budget", () => {
    activateLog("ws-running");
    appendBeat(beat("r-1"));
    protectLog("ws-running");
    for (let i = 0; i < MAX_WARM_LOGS + 2; i += 1) {
      activateLog(`ws-other-${i}`);
      appendBeat(beat(`o-${i}`));
    }
    expect(
      warmLogIds(),
      "evicting the beats of the one conversation still moving is a bug, not a saving",
    ).toContain("ws-running");
  });

  test("mutation: without the protection the running log is an ordinary candidate", () => {
    activateLog("ws-running");
    appendBeat(beat("r-1"));
    unprotectLog("ws-running"); // the guard, removed
    for (let i = 0; i < MAX_WARM_LOGS + 2; i += 1) {
      activateLog(`ws-other-${i}`);
      appendBeat(beat(`o-${i}`));
    }
    expect(
      warmLogIds(),
      "unprotected, the oldest log goes — which is what the protection exists to prevent",
    ).not.toContain("ws-running");
  });

  test("a CLOSED tab is forgotten outright, and its log stops being a warm one", () => {
    activateLog("ws-a");
    appendBeat(beat("a-1"));
    activateLog("ws-b");
    appendBeat(beat("b-1"));
    dropLog("ws-a");
    expect(warmLogIds(), "a closed tab holds nothing").not.toContain("ws-a");
    expect(
      logIsReloading(),
      "and it is a DELETION, not an eviction — nothing is going to reload it",
    ).toBe(false);

    dropLog("ws-b");
    expect(
      warmLogIds(),
      "the log ON SCREEN is refused: dropping it would leave the flow rendering nothing " +
        "with no workspace left to say why",
    ).toContain("ws-b");
    expect(displayedLogId()).toBe("ws-b");
  });
});

// ── C. Switching does not re-ingest ────────────────────────────────────────

describe("returning to a workspace reconciles instead of rebuilding", () => {
  test("the round trip keeps the beat objects — nothing was cleared and re-minted", () => {
    const listA = [userMsg("hello A", "db-a1"), assistantMsg("hi from A", "db-a2")];
    const listB = [userMsg("hello B", "db-b1")];

    // Workspace A, on chat "chat-a".
    selectChat("chat-a");
    setMessages(listA);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    expect(beatCount()).toBe(2);
    const heldFirst = beatById("b-db-a1");
    expect(heldFirst).toBeDefined();

    // The switch: the chat changes, which CLEARS the shared transcript store,
    // then B's history lands. Both of those reach the still-subscribed ingest.
    selectChat("chat-b");
    clearMessages();
    setMessages(listB);
    startIngest({ workspaceId: "ws-b", chatId: "chat-b", seamDebounceMs: 0 });
    expect(beatCount(), "B's own log holds B's transcript").toBe(1);

    // And back. A's history is re-read; the store is cleared first.
    selectChat("chat-a");
    clearMessages();
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    expect(
      beatCount(),
      "the beats are already there — the empty store between the switch and the read " +
        "must not be read as an empty conversation",
    ).toBe(2);
    setMessages(listA);
    expect(beatCount()).toBe(2);
    expect(
      beatById("b-db-a1"),
      "the SAME object. A rebuild would have minted a new beat for the same record, " +
        "which is exactly the re-ingest this whole change removes",
    ).toBe(heldFirst);
  });

  test("mutation: the old positional check reads an empty store as divergence", () => {
    // `syncMessages` as it was: any already-synced index missing from the
    // incoming list rebuilt the log. The store is empty for one tick on
    // EVERY chat switch, so this fired on every switch, always.
    const synced = [{ id: "db-a1" }, { id: "db-a2" }];
    const incoming: { id: string }[] = []; // clearMessages()
    let wouldRebuild = false;
    for (let i = 0; i < synced.length; i += 1) {
      if (i >= incoming.length || incoming[i]!.id !== synced[i]!.id) wouldRebuild = true;
    }
    expect(
      wouldRebuild,
      "the transcript being momentarily absent was treated as the transcript having changed",
    ).toBe(true);
  });

  test("the same records re-read under database ids keep their beats", () => {
    // A live run names its messages client-side; the database names the same
    // records by row id. Returning to a workspace re-reads them, so every id
    // changes and nothing else does.
    selectChat("chat-a");
    setMessages([userMsg("do the thing", "msg-1-live"), assistantMsg("done", "msg-2-live")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    const held = beatById("b-msg-1-live");
    expect(held).toBeDefined();

    setMessages([userMsg("do the thing", "db-77"), assistantMsg("done", "db-78")]);
    expect(beatCount(), "same conversation, same length").toBe(2);
    expect(
      beatById("b-msg-1-live"),
      "the record did not change, only its name did — the beat is kept",
    ).toBe(held);
    expect(beatById("b-db-77"), "and it is NOT also minted a second time").toBeUndefined();
  });

  test("mutation: a genuinely different transcript still rebuilds", () => {
    selectChat("chat-a");
    setMessages([userMsg("do the thing", "msg-1")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    const held = beatById("b-msg-1");
    expect(held).toBeDefined();

    // Different words: this is not the same record wearing a new id, and
    // keeping the beat would show the reader a sentence nobody sent.
    setMessages([userMsg("something else entirely", "db-99")]);
    expect(beatById("b-msg-1"), "the stale beat is gone").toBeUndefined();
    expect(beatById("b-db-99"), "and the real record has one").toBeDefined();
  });
});

// ── D. Attribution: a beat lands in the workspace it belongs to ────────────

describe("a store update reaches only the workspace it belongs to", () => {
  test("an ingest whose conversation is not the current one takes nothing", () => {
    selectChat("chat-a");
    setMessages([userMsg("A's words", "db-a1")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    expect(beatCount()).toBe(1);

    // The chat moved on but this ingest is still subscribed (it is stopped by
    // an effect one microtask later). Everything arriving now is somebody
    // else's conversation.
    selectChat("chat-b");
    setMessages([userMsg("B's words", "db-b1"), assistantMsg("B's reply", "db-b2")]);

    expect(
      beatCount(),
      "another conversation's transcript must not be appended to this log",
    ).toBe(1);
    expect(beatById("b-db-b1"), "not one beat of it").toBeUndefined();
  });

  test("mutation: without the conversation check the foreign transcript lands", () => {
    // The ingest as it was: `messages.subscribe` with no idea which chat the
    // list belongs to. Same inputs, replayed positionally.
    const synced = [{ id: "db-a1" }];
    const incoming = [{ id: "db-b1" }, { id: "db-b2" }];
    let rebuiltFrom: string[] = [];
    for (let i = 0; i < synced.length; i += 1) {
      if (incoming[i]!.id !== synced[i]!.id) rebuiltFrom = incoming.map((m) => m.id);
    }
    expect(
      rebuiltFrom,
      "the log would have been cleared and re-minted from the OTHER chat's messages",
    ).toEqual(["db-b1", "db-b2"]);
  });

  test("while another workspace's run is live, this workspace's log is frozen", () => {
    selectChat("chat-a");
    setMessages([userMsg("A's words", "db-a1")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    expect(beatCount()).toBe(1);

    // Workspace B is streaming. `state/chat-messages.ts` holds ONE transcript
    // for the page, so B's model output is appended to what is on screen.
    noteRunStarted(
      { runId: "run-b", workspaceId: "ws-b", chatId: "chat-b" },
      { close: () => {} },
      () => ({ close: () => {} }),
    );
    appendMessage(assistantMsg("B's model, in A's transcript", "db-b9"));

    expect(
      beatCount(),
      "a beat belonging to another workspace's run must not reach this log — this is the " +
        "correctness failure, not a cosmetic one",
    ).toBe(1);
    expect(beatById("b-db-b9")).toBeUndefined();
  });

  test("mutation: the freeze is about OWNERSHIP, not a blanket refusal to append", () => {
    selectChat("chat-a");
    setMessages([userMsg("A's words", "db-a1")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });

    // The identical sequence, with the live run owned by THIS workspace.
    noteRunStarted(
      { runId: "run-a", workspaceId: "ws-a", chatId: "chat-a" },
      { close: () => {} },
      () => ({ close: () => {} }),
    );
    appendMessage(assistantMsg("A's own reply", "db-a9"));

    expect(
      beatCount(),
      "a guard that refused every append while any run was live would be narrower than " +
        "its name and would stop the foreground run from rendering at all",
    ).toBe(2);
    expect(beatById("b-db-a9")).toBeDefined();
  });

  test("closing a tab forgets its cursor, so a later workspace cannot resume it", () => {
    selectChat("chat-a");
    setMessages([userMsg("A's words", "db-a1")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    // Closing the ACTIVE tab activates its neighbour first (closeWorkspace),
    // so the log being released is never the one on screen.
    activateLog("ws-neighbour");
    forgetIngestState("ws-a");
    dropLog("ws-a");

    // A fresh workspace under the same id (ids are minted per page, but the
    // cursor must not be what makes that safe).
    activateLog("ws-a");
    expect(beatCount()).toBe(0);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    expect(beatCount(), "it starts from the transcript, not from a dead cursor").toBe(1);
  });
});

// ── E. The live run: parked, not dropped ───────────────────────────────────

describe("a run whose tab is in the background is parked and re-attached", () => {
  test("switching away closes its stream; switching back re-opens it", () => {
    let closes = 0;
    let reopens = 0;
    noteRunStarted(
      { runId: "run-b", workspaceId: "ws-b", chatId: "chat-b" },
      { close: () => (closes += 1) },
      () => {
        reopens += 1;
        return { close: () => (closes += 1) };
      },
    );

    applyActiveWorkspace("ws-a");
    expect(closes, "the stream stops writing into the foreground transcript").toBe(1);
    expect(isParked("ws-b")).toBe(true);
    expect(hasLiveRun("ws-b"), "the RUN is not over — it is executing on the server").toBe(true);
    expect(activeWorkspaceForRuns()).toBe("ws-a");

    applyActiveWorkspace("ws-b");
    expect(reopens, "returning re-attaches to the same run").toBe(1);
    expect(isParked("ws-b")).toBe(false);
  });

  test("re-notifying the same active workspace neither closes nor re-opens anything", () => {
    applyActiveWorkspace("ws-b");
    let closes = 0;
    let reopens = 0;
    noteRunStarted(
      { runId: "run-b", workspaceId: "ws-b", chatId: "chat-b" },
      { close: () => (closes += 1) },
      () => {
        reopens += 1;
        return { close: () => (closes += 1) };
      },
    );
    applyActiveWorkspace("ws-b");
    applyActiveWorkspace("ws-b");
    expect(closes, "a run in the tab you are looking at is never parked").toBe(0);
    expect(reopens, "and never double-opened").toBe(0);
  });

  test("mutation: parking on any activation would kill the run you are watching", () => {
    // The plausible wrong rule — "the active workspace changed, so park" —
    // written out. It closes the stream of the tab the user is IN.
    let closed = false;
    const runWorkspace = "ws-b";
    const activated = "ws-b";
    if (activated !== null) closed = true; // no ownership comparison
    expect(closed).toBe(true);
    expect(
      runWorkspace === activated,
      "and this is the case it must not fire in",
    ).toBe(true);
  });

  test("the sole live run is reported only when there is exactly one", () => {
    expect(soleLiveRun(), "no run in flight: nothing to defend against").toBeNull();
    noteRunStarted(
      { runId: "run-a", workspaceId: "ws-a", chatId: "chat-a" },
      { close: () => {} },
      () => ({ close: () => {} }),
    );
    expect(soleLiveRun()?.workspaceId).toBe("ws-a");
    noteRunStarted(
      { runId: "run-b", workspaceId: "ws-b", chatId: "chat-b" },
      { close: () => {} },
      () => ({ close: () => {} }),
    );
    expect(
      soleLiveRun(),
      "two runs writing into one transcript store cannot be sorted out by any rule about " +
        "the tail — the honest answer is that there is no single owner",
    ).toBeNull();
    expect(liveRuns().length).toBe(2);

    noteRunEnded("run-b");
    expect(soleLiveRun()?.runId).toBe("run-a");
    noteRunEnded("run-a");
    expect(hasLiveRun("ws-a")).toBe(false);
  });
});

// ── F. The desk line is a projection about ONE conversation ────────────────

describe("the docked desk-line finding does not outlive its conversation", () => {
  beforeEach(() => {
    resetWorkspaces();
  });

  test("a workspace switch empties the slot", () => {
    proposeDeskLine(finding("context fills in ~12 messages"));
    expect(deskLine.get(), "the projection is docked").not.toBeNull();

    const other = openWorkspace();
    expect(activeWorkspaceId.get()).toBe(other.id);
    expect(
      deskLine.get(),
      "a sentence whose derivation names another conversation's messages must not sit " +
        "above this one's composer",
    ).toBeNull();
  });

  test("returning does NOT restore it — a stale projection is worse than none", () => {
    const first = activeWorkspaceId.get()!;
    proposeDeskLine(finding("context fills in ~12 messages"));
    const second = openWorkspace();
    activateWorkspace(first);
    expect(
      deskLine.get(),
      "its asOf and its input window would both be re-displayed as current; the next run " +
        "boundary proposes a fresh one from fresh inputs",
    ).toBeNull();
    expect(second.id).not.toBe(first);
  });

  test("mutation: the dismissal record is about the OPERATOR and survives the switch", () => {
    recordDismissal("context-projection");
    openWorkspace();
    expect(
      dismissalRecord().get("context-projection"),
      "'I keep waving this kind of finding away' is a fact about you, not about a tab — " +
        "clearing it with the slot would make the split cut in the wrong place",
    ).toBe(1);
  });
});

// ── G. The wiring is real ──────────────────────────────────────────────────

describe("the workspace atoms and the flow's logs are actually joined", () => {
  test("the ingest addresses the log named by its workspace", () => {
    selectChat("chat-a");
    setMessages([userMsg("only A", "db-a1")]);
    startIngest({ workspaceId: "ws-a", chatId: "chat-a", seamDebounceMs: 0 });
    expect(displayedLogId(), "starting an ingest puts its workspace's log on screen").toBe("ws-a");
    expect(currentChatId.get()).toBe("chat-a");
  });

  test("a mount with no workspace uses the single unnamed log, exactly as before", () => {
    setMessages([userMsg("harness", "db-h1")]);
    startIngest({ seamDebounceMs: 0 });
    expect(displayedLogId()).toBe(DEFAULT_LOG_ID);
    expect(beatCount()).toBe(1);
  });
});


test("a late accepted stream is parked under its original workspace, including a null active workspace", () => {
  applyActiveWorkspace("ws-b");
  let closes = 0, opens = 0;
  noteRunStarted({ runId: "late-a", workspaceId: "ws-a", chatId: "chat-a" },
    { close: () => { closes++; } }, () => { opens++; return { close: () => { closes++; } }; });
  expect(closes, "registration after a switch immediately parks the original owner's source").toBe(1);
  expect(liveRuns()).toEqual([{ runId: "late-a", workspaceId: "ws-a", chatId: "chat-a" }]);
  applyActiveWorkspace("ws-a");
  expect(opens).toBe(1);
  applyActiveWorkspace(null);
  expect(closes).toBe(2);
  expect(hasLiveRun("ws-a")).toBe(true);
  resetRunOwnership();
  expect(liveRuns()).toEqual([]);
});

test("repeated registration retires only the superseded controller for that run", () => {
  resetRunOwnership();
  applyActiveWorkspace("ws-race");
  const run = { runId: "same-run", workspaceId: "ws-race", chatId: "same-chat" };
  let firstCloses = 0;
  let secondCloses = 0;
  let thirdCloses = 0;
  let reopenCount = 0;
  const first = { close: () => { firstCloses += 1; } };
  const second = { close: () => { secondCloses += 1; } };
  const third = { close: () => { thirdCloses += 1; } };
  const reopen = () => { reopenCount += 1; return third; };
  try {
    noteRunStarted(run, first, reopen);
    noteRunStarted(run, first, reopen);
    expect(firstCloses, "re-notifying the same controller keeps it usable").toBe(0);
    noteRunStarted(run, second, reopen);
    expect(firstCloses, "a second attachment must retire the source the map would otherwise lose").toBe(1);
    expect(secondCloses).toBe(0);
    expect(liveRuns()).toEqual([run]);
    applyActiveWorkspace("ws-other");
    expect(secondCloses).toBe(1);
    noteRunStarted(run, third, reopen);
    expect(secondCloses, "a previously parked controller is not retired twice").toBe(1);
    expect(thirdCloses, "a replacement registered in the background is parked").toBe(1);
    applyActiveWorkspace("ws-race");
    expect(reopenCount).toBe(1);
  } finally { resetRunOwnership(); }
});
