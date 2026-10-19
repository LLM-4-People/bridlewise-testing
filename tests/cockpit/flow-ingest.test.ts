// @vitest-environment node
/**
 * Ingestion (spec §3.8 + §3.2 derived beats): the surviving stores feed the
 * beat log incrementally. Covers the 1:1 message mapping, effect derivation
 * from file-editing tool calls, check DELTAS (never standing state), the
 * turn seam on run end, and the desk-line projection proposal.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  appendMessage,
  appendToolCall,
  appendUserMessage,
  clearMessages,
  setMessages,
  setStreaming,
  updateToolCallById,
  type ChatMessage,
} from "../../src/state/chat-messages.ts";
import {
  resetAutoChecks,
  setAutoChecksScope,
  upsertAutoChecks,
  type AutoCheck,
} from "../../src/state/auto-checks.ts";
import {
  clearChatHistoryLoad,
  noteChatHistoryRead,
  noteChatHistoryUnread,
} from "../../src/state/chat-history-load.ts";
import { selectChat } from "../../src/state/chats.ts";
import { resetIngest, startIngest } from "../../src/cockpit/flow/ingest.ts";
import { beatCount, windowSlice, beatById } from "../../src/cockpit/flow/log.ts";
import { deskLine, resetAdmission } from "../../src/cockpit/computer/admission.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import { setTools, resetTools } from "../../src/state/tools.ts";
import type { WebToolEntry } from "../../shared/types.ts";

/**
 * The manifest entry the file-effect derivation reads. The effect beat is
 * committed only for a tool the served manifest declares a writer (the
 * `write` capability) — never a hand list. Seed it so the real derivation
 * is what admits the `edit` call below.
 */
const EDIT_ENTRY: WebToolEntry = {
  id: "edit",
  name: "edit",
  description: "edit tool",
  label: "edit file",
  inputSchema: {},
  capabilities: Object.freeze(["write"]),
  bounds: { timeoutMs: 1000, maxOutputBytes: 0, maxMemoryBytes: 0 },
  adapterId: "web-ui-editor",
  category: "built-in",
  kind: "editor",
};

function allBeats(): readonly Beat[] {
  return windowSlice(0, beatCount());
}

let nextId = 0;
function assistantMsg(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  nextId += 1;
  return {
    id: `db-a-${nextId}`,
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...extra,
  } as ChatMessage;
}

function check(id: string, status: AutoCheck["status"]): AutoCheck {
  return {
    id,
    projectId: "p1",
    chatId: "c1",
    checkName: "typecheck",
    status,
    output: { errors: [1, 2, 3] },
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  clearMessages();
  resetAutoChecks();
  resetAdmission();
  resetIngest();
  clearChatHistoryLoad();
  selectChat(null);
  setTools([EDIT_ENTRY]);
});
afterEach(() => {
  resetIngest();
  clearMessages();
  resetAutoChecks();
  resetAdmission();
  clearChatHistoryLoad();
  selectChat(null);
  resetTools();
});

describe("ingest — messages → beats", () => {
  test("user and model turns map 1:1 with causal parentage", () => {
    startIngest();
    appendUserMessage("refactor the reader path");
    appendMessage(assistantMsg("on it", { tokenMetrics: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }));
    const beats = allBeats();
    expect(beats).toHaveLength(2);
    expect(beats[0]!.kind).toBe("turn");
    expect(beats[0]!.turn?.who).toBe("you");
    expect(beats[1]!.turn?.who).toBe("model");
    expect(beats[1]!.parentId).toBe(beats[0]!.id);
    expect(beats[1]!.turn?.inputTokens).toBe(100);
    expect(beats[1]!.turnIndex).toBe(0);
  });

  test("a STEERED user message carries its queued state onto the turn beat", () => {
    // The steer routing marks the message (`appendUserMessage(text, true)`);
    // the beat must forward it so the flow renders "steered the live run" on
    // the reader's own words — an unmarked steered message would render as
    // though it had started a run, which is exactly the lie the marking
    // exists to prevent. MUTATION: drop the `steered` forwarding in
    // `beatFromMessage` and this reds while the message still carries it.
    startIngest();
    appendUserMessage("use the other approach", true);
    appendUserMessage("a plain follow-up");
    const beats = allBeats();
    expect(beats[0]!.turn?.steered).toBe(true);
    expect(beats[1]!.turn?.steered).toBeUndefined();
  });

  test("a model turn carries its call's dedup savings onto the beat", () => {
    // The footer renders the savings FROM THE BEAT, so the join the face
    // reads is this forwarding: a message whose record holds the call's
    // dedup summary must put it on the turn beat, and a message without
    // one must forward nothing — the footer's absence is honest only if
    // the beat never invents or drops the fact. MUTATION: drop the
    // `dedupSummary` forwarding in `beatFromMessage` and the first
    // assertion reds while the message still carries it.
    startIngest();
    appendUserMessage("read the plan");
    appendMessage(assistantMsg("on it", {
      dedupSummary: {
        applied: true,
        originalChars: 2440,
        dedupedChars: 1845,
        charReductionPct: 24.39,
        removedBlocks: 5,
        removedLines: 31,
        messageCount: 5,
      },
    }));
    appendMessage(assistantMsg("no repeats this time"));
    const beats = allBeats().filter((b) => b.turn?.who === "model");
    expect(beats[0]!.turn?.dedupSummary?.charReductionPct).toBe(24.39);
    expect(beats[0]!.turn?.dedupSummary?.removedBlocks).toBe(5);
    expect(beats[1]!.turn?.dedupSummary).toBeUndefined();
  });

  test("a model turn carries its call's redaction notice onto the beat", () => {
    // The footer renders the masking FROM THE BEAT, so the join the face
    // reads is this forwarding: a message whose record holds the call's
    // redaction notice must put it on the turn beat, and a message without
    // one must forward nothing — the footer's absence is honest only if
    // the beat never invents or drops the fact. MUTATION: drop the
    // `redactionNotice` forwarding in `beatFromMessage` and the first
    // assertion reds while the message still carries it.
    startIngest();
    appendUserMessage("here is my api key");
    appendMessage(assistantMsg("noted", {
      redactionNotice: {
        maskedCount: 2,
        proven: 1,
        format: 0,
        inferred: 1,
        maskedUpstream: 0,
        byTier: { selfValidating: 1, declaredValues: 1 },
        reasons: [
          { confidence: "proven", category: "credential", maskedLength: 24, explanation: "equals a credential this machine holds" },
          { confidence: "inferred", category: "password", maskedLength: 8, explanation: "the words around it introduced it and its shape agreed" },
        ],
      },
    }));
    appendMessage(assistantMsg("nothing masked this time"));
    const beats = allBeats().filter((b) => b.turn?.who === "model");
    expect(beats[0]!.turn?.redactionNotice?.maskedCount).toBe(2);
    expect(beats[0]!.turn?.redactionNotice?.proven).toBe(1);
    expect(beats[0]!.turn?.redactionNotice?.inferred).toBe(1);
    expect(beats[1]!.turn?.redactionNotice).toBeUndefined();
  });

  test("a model turn carries its reconcile verdict onto the beat, as an abnormal ending", () => {
    // The flow renders the ending FROM THE BEAT (the quiet line + the alarm
    // state), so the join the face reads is this forwarding: a message the
    // reconcile settled must put its verdict on the turn beat and raise the
    // abnormal flag with it — the reader must not carry on believing an
    // answer is coming. A message without a verdict forwards nothing and
    // stays a plain turn. MUTATION: drop the `incompleteReason` forwarding
    // in `beatFromMessage` and the first two assertions red while the
    // message still carries the verdict.
    startIngest();
    appendUserMessage("write a 900-word story about a lighthouse keeper");
    appendMessage(assistantMsg("", {
      runId: "run-died-mid-stream",
      incompleteReason: "the run ended before this answer was kept",
    }));
    appendMessage(assistantMsg("answered in full"));
    const beats = allBeats().filter((b) => b.turn?.who === "model");
    expect(beats[0]!.turn?.incompleteReason).toBe("the run ended before this answer was kept");
    expect(beats[0]!.abnormal, "a dead turn is abnormal — the same register an error row takes").toBe(true);
    expect(beats[1]!.turn?.incompleteReason).toBeUndefined();
    expect(beats[1]!.abnormal).toBe(false);
  });

  test("a successful file-editing tool call commits an effect beat, parented to it", () => {
    startIngest();
    appendUserMessage("edit something");
    appendMessage(assistantMsg("editing"));
    appendToolCall({
      id: "call-1",
      name: "edit",
      input: { path: "src/x.ts", patch: "@@" },
      output: undefined,
      status: "running",
      startedAt: Date.now(),
    });
    // Still running: no effect yet.
    expect(allBeats().filter((b) => b.kind === "effect")).toHaveLength(0);
    updateToolCallById("call-1", (tc) => ({ ...tc, status: "done", output: "ok" }));
    const effects = allBeats().filter((b) => b.kind === "effect");
    expect(effects).toHaveLength(1);
    expect(effects[0]!.effect?.path).toBe("src/x.ts");
    const toolBeat = allBeats().find((b) => b.kind === "tool")!;
    expect(effects[0]!.parentId).toBe(toolBeat.id);
    // Idempotent on further updates.
    updateToolCallById("call-1", (tc) => ({ ...tc, durationMs: 5 }));
    expect(allBeats().filter((b) => b.kind === "effect")).toHaveLength(1);
  });

  test("a read-only tool call commits NO effect beat", () => {
    startIngest();
    appendUserMessage("read");
    appendMessage(assistantMsg("reading"));
    appendToolCall({
      id: "call-2",
      name: "read_file",
      input: { path: "src/x.ts" },
      output: "content",
      status: "done",
      startedAt: Date.now(),
    });
    expect(allBeats().filter((b) => b.kind === "effect")).toHaveLength(0);
  });

  // ── THE MANIFEST CAN ARRIVE AFTER THE BEATS ─────────────────────────────
  //
  // The effect fold reads `fileEffectToolNames()` (the manifest store), and
  // the manifest is a SESSION read that can land after the first sync — at
  // boot it races the history read, and a workspace tab resumes against
  // whatever the store holds. A beat folded against an absent manifest
  // stayed effect-less forever: no `see what changed`, no keep/undo verbs,
  // the pane's edits reading "no files touched yet" for a run that wrote a
  // real file. The fold must re-run when the manifest lands — in causal
  // position, never appended at the tail.

  test("a manifest arriving AFTER the beats were built heals the missing effect beats, in position", () => {
    // The boot race, modeled exactly: the ingest runs against an EMPTY
    // manifest, a settled edit call is already in the transcript, and only
    // then does the manifest land.
    resetTools();
    startIngest();
    appendUserMessage("create the file");
    appendMessage(assistantMsg("writing it"));
    appendToolCall({
      id: "call-late",
      name: "edit",
      input: { path: "notes/scratch.md", oldString: "", newString: "hi" },
      output: '{"ok":true}',
      status: "done",
      startedAt: Date.now(),
    });
    // A later turn already streamed after the tool call — the effect's
    // position is mid-log, where a tail-append would put it in the wrong
    // place.
    appendMessage(assistantMsg("done writing"));
    expect(allBeats().filter((b) => b.kind === "effect"), "no manifest, no effect vocabulary").toHaveLength(0);

    // The manifest lands (the store gains its session read).
    setTools([EDIT_ENTRY]);

    const beats = allBeats();
    const effectIdx = beats.findIndex((b) => b.kind === "effect");
    expect(effectIdx, "the manifest landing re-folds the settled call").toBeGreaterThanOrEqual(0);
    const toolIdx = beats.findIndex((b) => b.kind === "tool");
    const laterTurnIdx = beats.findIndex((b) => b.kind === "turn" && b.turn?.text === "done writing");
    expect(effectIdx, "the effect sits immediately after its tool beat, not at the tail").toBe(toolIdx + 1);
    expect(effectIdx, "and before the beats that followed the call").toBeLessThan(laterTurnIdx);
    expect(beats[effectIdx]!.effect?.path).toBe("notes/scratch.md");
    expect(beats[effectIdx]!.parentId).toBe(beats[toolIdx]!.id);
    // Idempotent: a second manifest write with nothing missing changes nothing.
    setTools([EDIT_ENTRY]);
    expect(allBeats().filter((b) => b.kind === "effect")).toHaveLength(1);
  });

  test("a manifest arriving with NOTHING to heal rebuilds nothing", () => {
    // The guard: a manifest refresh (an enabled-set flip re-read) must not
    // discard the reader's log when no effect is missing. Model it by
    // planting a fresh manifest reference with the same vocabulary and
    // asserting the beat ids survive (a rebuild would re-mint them).
    startIngest();
    appendUserMessage("plain turn");
    const before = allBeats().map((b) => b.id);
    setTools([EDIT_ENTRY]);
    expect(allBeats().map((b) => b.id)).toEqual(before);
  });

  test("hydration divergence rebuilds the log from the new transcript", () => {
    startIngest();
    appendUserMessage("live message");
    expect(beatCount()).toBe(1);
    // Chat switch: the store is bulk-replaced with DB history (new ids).
    setMessages([
      { id: "db-1", role: "user", content: "from history", timestamp: 1 },
      { id: "db-2", role: "assistant", content: "answer", timestamp: 2 },
    ]);
    const beats = allBeats();
    expect(beats).toHaveLength(2);
    expect(beats[0]!.id).toBe("b-db-1");
    expect(beatById("b-db-1")?.turn?.text).toBe("from history");
  });
});

describe("ingest — check deltas (§3.2: deltas ONLY)", () => {
  test("standing state on first observation is NOT a beat; a transition is", () => {
    setAutoChecksScope("p1", "c1");
    upsertAutoChecks([check("chk-1", "passed")]);
    startIngest();
    expect(allBeats().filter((b) => b.kind === "check-delta")).toHaveLength(0);
    upsertAutoChecks([check("chk-1", "failed")]);
    const deltas = allBeats().filter((b) => b.kind === "check-delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.checkDelta).toMatchObject({
      checkName: "typecheck",
      from: "passed",
      to: "failed",
      errorCount: 3,
    });
    expect(deltas[0]!.abnormal).toBe(true);
    // Same status again: no new delta.
    upsertAutoChecks([check("chk-1", "failed")]);
    expect(allBeats().filter((b) => b.kind === "check-delta")).toHaveLength(1);
  });

  test("a transition into 'running' is transient, not a delta beat", () => {
    setAutoChecksScope("p1", "c1");
    upsertAutoChecks([check("chk-2", "passed")]);
    startIngest();
    upsertAutoChecks([check("chk-2", "running")]);
    expect(allBeats().filter((b) => b.kind === "check-delta")).toHaveLength(0);
  });
});

describe("ingest — a withdrawn region withdraws TOGETHER (UIE-013)", () => {
  // The edit & resend / rewind reload hands the ingest a transcript whose
  // withdrawn suffix — the user turn AND its run's error rows — is gone.
  // The beats must go with the rows: an error beat whose every row left the
  // live view is an orphan claiming a run the conversation no longer holds.
  const dbMsg = (id: string, role: "user" | "error", content: string): ChatMessage =>
    ({ id, role, content, timestamp: Date.now() }) as ChatMessage;

  test("the withdrawn turn's error beats leave the log with it", () => {
    startIngest();
    // The pre-withdrawal transcript: two failed-probe turns, each with its
    // 402 pair (the persisted, database-id shape a reload serves).
    setMessages([
      dbMsg("db-u-1", "user", "timing-probe holder"),
      dbMsg("db-e-1", "error", "unexpected HTTP 402: first"),
      dbMsg("db-e-2", "error", "unexpected HTTP 402: second"),
      dbMsg("db-u-2", "user", "racing right after the visible error"),
      dbMsg("db-e-3", "error", "unexpected HTTP 402: third"),
      dbMsg("db-e-4", "error", "unexpected HTTP 402: fourth"),
    ]);
    expect(allBeats()).toHaveLength(6);

    // The withdrawal reload: the second turn and everything after it were
    // withdrawn — the mapper drops the discarded rows, so the store's new
    // list is the surviving prefix.
    setMessages([
      dbMsg("db-u-1", "user", "timing-probe holder"),
      dbMsg("db-e-1", "error", "unexpected HTTP 402: first"),
      dbMsg("db-e-2", "error", "unexpected HTTP 402: second"),
    ]);

    const beats = allBeats();
    expect(beats).toHaveLength(3);
    const texts = beats.map((b) =>
      b.kind === "turn" ? b.turn?.text : b.kind === "event" ? b.event?.text : b.id,
    );
    expect(texts).not.toContain("racing right after the visible error");
    expect(texts.join(" ")).not.toContain("third");
    expect(texts.join(" ")).not.toContain("fourth");
  });

  test("the withdrawn region's replacement arrives on a clean log (edit & resend end state)", () => {
    startIngest();
    setMessages([
      dbMsg("db-u-1", "user", "timing-probe holder"),
      dbMsg("db-e-1", "error", "unexpected HTTP 402: first"),
      dbMsg("db-u-2", "user", "racing right after the visible error"),
      dbMsg("db-e-2", "error", "unexpected HTTP 402: second"),
    ]);
    // Withdrawal, then the corrected resend lands as a NEW persisted turn
    // (the run's own row), followed by its own error — one error beat for
    // one failed run, nothing orphaned in between.
    setMessages([
      dbMsg("db-u-1", "user", "timing-probe holder"),
      dbMsg("db-e-1", "error", "unexpected HTTP 402: first"),
      dbMsg("db-u-3", "user", "racing right after the visible error — v2"),
    ]);
    appendMessage(dbMsg("db-e-3", "error", "unexpected HTTP 402: the new run"));
    const beats = allBeats();
    const errorBeats = beats.filter((b) => b.kind === "event");
    expect(errorBeats).toHaveLength(2); // the survivor's, and the new run's
    const orphan = errorBeats.find((b) => b.event?.text.includes("second"));
    expect(orphan, "the withdrawn region's error beat survived its own withdrawal").toBeUndefined();
  });
});

describe("ingest — run boundary (§3.3 step 8, §4.3)", () => {
  test("streaming end appends exactly one seam with the measured rollup + derivation", () => {
    startIngest({ seamDebounceMs: 0 });
    setStreaming(true);
    appendUserMessage("do the thing");
    appendMessage(
      assistantMsg("did the thing", {
        tokenMetrics: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
      }),
    );
    appendToolCall({
      id: "call-3",
      name: "edit",
      input: { path: "src/y.ts" },
      output: "ok",
      status: "done",
      startedAt: Date.now(),
    });
    setStreaming(false);
    const seams = allBeats().filter((b) => b.kind === "seam");
    expect(seams).toHaveLength(1);
    const seam = seams[0]!.seam!;
    expect(seam.sentence).toMatch(/turn 1/);
    expect(seam.sentence).toMatch(/1 file changed/);
    expect(seam.sentence).toMatch(/↑1,200/);
    expect(seam.derivation.steps.length).toBeGreaterThan(0);
    expect(seam.derivation.asOf).toBeGreaterThan(0);
  });

  test("desk-line projection is proposed only from ≥2 measured context points", () => {
    startIngest({ seamDebounceMs: 0 });
    setStreaming(true);
    appendUserMessage("one");
    appendMessage(
      assistantMsg("first", {
        context: {
          systemPrompt: "s",
          toolNames: [],
          historyLength: 1,
          contextTokens: 10_000,
          contextTokenLimit: 100_000,
        },
      }),
    );
    setStreaming(false);
    // One measured point: no projection (honest absence).
    expect(deskLine.get()).toBeNull();
    setStreaming(true);
    appendUserMessage("two");
    appendMessage(
      assistantMsg("second", {
        context: {
          systemPrompt: "s",
          toolNames: [],
          historyLength: 2,
          contextTokens: 14_000,
          contextTokenLimit: 100_000,
        },
      }),
    );
    setStreaming(false);
    const line = deskLine.get();
    expect(line).not.toBeNull();
    expect(line!.finding.sentence).toMatch(/projection from/);
    expect(line!.finding.derivation.window).toBeDefined();
  });
});

/**
 * ── THE MEASURED-EMPTY RULE ────────────────────────────────────────────────
 *
 * An empty transcript is two different facts (state/chat-history-load.ts):
 * "not arrived yet" holds the warm beats; "arrived, and the conversation is
 * empty" clears them. Without the second branch a NEW conversation rendered
 * the PREVIOUS conversation's beats until the first send — the transcript
 * store was empty, the ingest held what it had, and what it had was another
 * conversation.
 */
describe("ingest — a measured-empty history clears the previous conversation's beats", () => {
  test("switching to an empty conversation ends at zero beats once the read lands", () => {
    selectChat("c1");
    startIngest({ chatId: "c1" });
    appendUserMessage("words in the first conversation");
    appendMessage(assistantMsg("an answer in the first conversation"));
    expect(beatCount()).toBe(2);

    // The switch: selection moves, the transcript store clears, the history
    // read for the new conversation is still in flight (load = null after
    // the context reset).
    selectChat("c2");
    clearChatHistoryLoad();
    clearMessages();
    startIngest({ chatId: "c2" });
    // In flight = absence: the warm beats hold (this is the keep-alive rule,
    // not the defect).
    expect(beatCount()).toBe(2);

    // The read LANDS and the conversation is measured empty. The one owner
    // says which kind of empty this is, and the beats go.
    setMessages([]);
    noteChatHistoryRead("c2");
    expect(beatCount()).toBe(0);
  });

  test("a measured-empty read for a DIFFERENT conversation clears nothing", () => {
    selectChat("c1");
    startIngest({ chatId: "c1" });
    appendUserMessage("held words");
    appendMessage(assistantMsg("held answer"));
    expect(beatCount()).toBe(2);
    // The transcript empties (the switch's clear) while the load slot still
    // holds a measured emptiness for some OTHER conversation. That says
    // nothing about this one; the beats stand.
    noteChatHistoryRead("c9");
    clearMessages();
    expect(beatCount()).toBe(2);
  });

  test("an ABSENT (failed) read holds the beats — only a measurement clears", () => {
    selectChat("c1");
    startIngest({ chatId: "c1" });
    appendUserMessage("kept through the failure");
    appendMessage(assistantMsg("kept too"));
    selectChat("c2");
    clearChatHistoryLoad();
    clearMessages();
    startIngest({ chatId: "c2" });
    // The read BROKE: that is an absence with a reason, not a measured
    // emptiness — clearing on it would assert an empty conversation nobody
    // measured.
    noteChatHistoryUnread("c2", "not answering right now", "second conversation");
    expect(beatCount()).toBe(2);
  });
});
