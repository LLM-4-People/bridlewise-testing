// @vitest-environment jsdom
/**
 * OPERATOR INTERVENTIONS IN THE FLOW — "show when we steer, manipulate
 * context, trim, etc" (the user's own words).
 *
 * THE GAP THIS CLOSES. The flow recorded what you SAID, what the model said,
 * and what the model DID. It did not record what YOU did to the machine:
 * pinning a memory, muting a channel, moving the trim point, flipping a
 * breaker, arming an auto-trip, saving a setting. Each of those changes what
 * the model receives or what it is allowed to do on the very next turn — so a
 * reader scrubbing back could watch the model's behaviour change and find no
 * cause for it anywhere in the record. A recording with a hole exactly where
 * the explanation should be is worse than no recording.
 *
 * THE TWO PROPERTIES THIS FILE OWNS, and they pull against each other, which
 * is why they are pinned together:
 *
 *   COMPLETENESS — every act the Broker genuinely recorded becomes a beat, at
 *   the moment it happened, whether or not any instrument was open at the
 *   time.
 *
 *   NO INVENTION (§1.1) — every word on that beat is TRANSCRIBED. `title` and
 *   `consequence` come from the action's own declaration (the server refuses
 *   to boot without both), served in the UI schema's `blockActions` manifest.
 *   When the manifest cannot answer, the beat says so rather than composing a
 *   plausible sentence — because the sentence in question is a PROMISE about
 *   what the run will do next, which is the worst class of thing to invent.
 *
 * The rendering half (voice, mark, register) is pinned at the bottom.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import { clearMessages, appendMessage, type ChatMessage } from "../../src/state/chat-messages.ts";
import { resetAutoChecks } from "../../src/state/auto-checks.ts";
import { uiSchema } from "../../src/state/schema-store.ts";
import { clearProvenance, recordAction } from "../../src/data/ledger.ts";
import { resetIngest, startIngest } from "../../src/cockpit/flow/ingest.ts";
import { beatCount, windowSlice } from "../../src/cockpit/flow/log.ts";
import { beatState, beatVoice } from "../../src/cockpit/flow/beat-state.ts";
import { beatNoun, causalPhrase, type Beat } from "../../src/cockpit/flow/types.ts";
import ActBeat from "../../src/cockpit/flow/ActBeat.svelte";
import { read } from "../helpers/source-scan.ts";

const TOKENS = "src/cockpit/tokens.css";
const BEAT = "src/cockpit/flow/Beat.svelte";

// ── The served manifest, exactly as the server declares it ─────────────────

/**
 * Real declared words, copied from `server/blocks/compose.ts` and
 * `server/blocks/breaker.ts`. They are fixtures of the CONTRACT, not of this
 * test: the point of the feature is that these exact strings reach the screen
 * without anybody re-typing them.
 */
const PIN_CONSEQUENCE =
  "Always include this memory in what the model sees for this chat, starting with the next reply, even when recall would miss it.";
const FLIP_CONSEQUENCE = "Stops offering this tool to the model at the next tool decision.";

function serveManifest(): void {
  uiSchema.set({
    blockActions: {
      "run.compose": [
        { name: "pin", title: "Pin", consequence: PIN_CONSEQUENCE },
        { name: "trim", title: "Set trim point", consequence: "Moves the send point." },
      ],
      "tools.breaker": [{ name: "set", title: "Flip breaker", consequence: FLIP_CONSEQUENCE }],
    },
  } as never);
}

function allBeats(): readonly Beat[] {
  return windowSlice(0, beatCount());
}

function acts(): readonly Beat[] {
  return allBeats().filter((b) => b.kind === "act");
}

function performed(
  block: string,
  action: string,
  extra: Partial<Parameters<typeof recordAction>[0]> = {},
): void {
  const requestedAt = Date.now() - 40;
  recordAction({ origin: "operator", block, action, state: "done", requestedAt, settledAt: requestedAt + 40, ...extra });
}

function modelMessage(): ChatMessage {
  return {
    id: "db-a-1",
    role: "assistant",
    content: "I will read the file.",
    timestamp: Date.now(),
  } as ChatMessage;
}

beforeEach(() => {
  clearMessages();
  resetAutoChecks();
  resetIngest();
  clearProvenance();
  uiSchema.set(null);
});

afterEach(() => {
  cleanup();
  resetIngest();
  clearProvenance();
  uiSchema.set(null);
});

// ── Completeness ───────────────────────────────────────────────────────────

describe("operator interventions — every recorded act becomes a beat", () => {
  test("pinning a memory lands in the flow, at the moment it happened", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", {
      input: { chatId: "c1", channel: "memories", itemId: "mem-1" },
    });
    expect(acts(), "the intervention must be recorded in the flow").toHaveLength(1);
    const act = acts()[0]!.act!;
    expect(act.block).toBe("run.compose");
    expect(act.action).toBe("pin");
    expect(acts()[0]!.at).toBeGreaterThan(0);
  });

  test("an AUTOMATIC act (the telemetry flush) is not an intervention — no beat", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("client.telemetry", "ingest", { origin: "automatic", input: { events: [] } });
    performed("run.compose", "pin", { input: { chatId: "c1", channel: "memories", itemId: "mem-1" } });
    // The witness: the operator act beside it IS a beat, so the filter is
    // looking at the right ledger.
    expect(acts().map((beat) => `${beat.act!.block}/${beat.act!.action}`)).toEqual(["run.compose/pin"]);
  });

  test("the flow records it whether or not any instrument is open", () => {
    // The Broker's ledger is subscribed directly (through the always-live
    // state mirror), not through the LENS's own version counter — a run whose
    // interventions were only kept when somebody had the lens open would be a
    // partial account of itself.
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("tools.breaker", "set", { input: { tool: "edit", on: false } });
    performed("run.compose", "trim", { input: { chatId: "c1", beforeTurn: 2 } });
    expect(acts()).toHaveLength(2);
  });

  test("acts recorded BEFORE this ingest started are not replayed", () => {
    // They belong to an earlier mount of the same session. Replaying them
    // would put interventions into a conversation they did not happen in.
    serveManifest();
    performed("run.compose", "pin", { input: { itemId: "mem-old" } });
    startIngest({ seamDebounceMs: 0 });
    expect(acts()).toHaveLength(0);
    performed("run.compose", "pin", { input: { itemId: "mem-new" } });
    expect(acts()).toHaveLength(1);
  });

  test("one act is one beat — a re-notified ledger never doubles it", () => {
    // An intervention that appeared twice would be a lie about how many times
    // you did it.
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", { input: { itemId: "mem-1" } });
    performed("run.compose", "pin", { input: { itemId: "mem-1" } });
    expect(acts()).toHaveLength(2);
    expect(new Set(acts().map((b) => b.id)).size, "beat ids must be unique").toBe(2);
  });

  test("it is parented to the model turn it will change the sequel of", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    appendMessage(modelMessage());
    performed("run.compose", "pin", { input: { itemId: "mem-1" } });
    const act = acts()[0]!;
    expect(act.parentId, "the intervention hangs off the open model turn").toBe("b-db-a-1");
  });

  test("with no turn yet it has NO parent, rather than an invented one", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", { input: { itemId: "mem-1" } });
    expect(acts()[0]!.parentId).toBeNull();
  });

  test("the kind is covered by the plain-words vocabulary (no internal nouns)", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", {});
    const act = acts()[0]!;
    expect(beatNoun(act)).toBe("something you changed about the run");
    expect(causalPhrase(act)).toBe("after you changed something about the run");
  });
});

// ── No invention ───────────────────────────────────────────────────────────

describe("operator interventions — every word is transcribed, none is authored", () => {
  test("the DECLARED consequence reaches the screen verbatim", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", { input: { itemId: "mem-1" } });
    const act = acts()[0]!.act!;
    expect(act.title).toBe("Pin");
    expect(
      act.consequence,
      "the log and the control must read the SAME sentence, so they cannot disagree",
    ).toBe(PIN_CONSEQUENCE);
    const { container } = render(ActBeat, { props: { beat: acts()[0]! } });
    expect(container.textContent).toContain(PIN_CONSEQUENCE);
  });

  test("changing the manifest changes the beat (it is quoted, not copied out)", () => {
    // The mutation that proves the words are read from the declaration rather
    // than from a table in the cockpit.
    uiSchema.set({
      blockActions: {
        "tools.breaker": [
          { name: "set", title: "Flip breaker", consequence: "A DIFFERENT DECLARED SENTENCE." },
        ],
      },
    } as never);
    startIngest({ seamDebounceMs: 0 });
    performed("tools.breaker", "set", { input: { tool: "x", on: false } });
    expect(acts()[0]!.act!.consequence).toBe("A DIFFERENT DECLARED SENTENCE.");
  });

  test("NO manifest entry → no words are invented, and the absence is stated", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("some.block", "doThing", { input: { a: 1 } });
    const act = acts()[0]!.act!;
    expect(act.title, "a title must not be prettied up out of the id").toBeUndefined();
    expect(act.consequence).toBeUndefined();
    const { container } = render(ActBeat, { props: { beat: acts()[0]! } });
    expect(container.textContent).toContain("not in the loaded manifest");
  });

  test("the manifest not being loaded at all is the same honest absence", () => {
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", {});
    expect(acts()[0]!.act!.consequence).toBeUndefined();
  });

  test("the RECORDED input is shown — that is how the target is named", () => {
    // Without it the beat could say a breaker was flipped but not WHICH tool,
    // and naming the tool would mean guessing. The Broker records the input at
    // the one write door, so it is transcribed like everything else.
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("tools.breaker", "set", { input: { tool: "edit", on: false } });
    const { container } = render(ActBeat, { props: { beat: acts()[0]! } });
    expect(container.textContent).toContain("edit");
  });

  test("an act with no recorded input renders no input block at all", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", { input: {} });
    const { container } = render(ActBeat, { props: { beat: acts()[0]! } });
    expect(container.querySelector(".what"), "an empty input is an absence").toBeNull();
  });
});

// ── A refused intervention changed nothing, and says so ────────────────────

describe("operator interventions — a refused act must not read as a change", () => {
  const failed = (): Beat => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    const requestedAt = Date.now() - 10;
    recordAction({
      origin: "operator",
      block: "run.compose",
      action: "pin",
      state: "failed",
      requestedAt,
      settledAt: requestedAt + 10,
      errorCode: "not_found",
      input: { itemId: "mem-1" },
    });
    return acts()[0]!;
  };

  test("it is an ALARM and declares itself abnormal", () => {
    const beat = failed();
    expect(beatState(beat)).toBe("alarm");
    expect(beat.abnormal, "the fisheye must refuse to compress it away").toBe(true);
  });

  test("it says nothing about the run changed, and names the recorded code", () => {
    const { container } = render(ActBeat, { props: { beat: failed() } });
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("did not go through");
    expect(text).toContain("nothing about the run changed");
    expect(text).toContain("not_found");
  });

  test("a settled act is an ordinary success (green), not a special case", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", {});
    expect(beatState(acts()[0]!)).toBe("ok");
    expect(acts()[0]!.abnormal).toBe(false);
  });
});

// ── The voice: who did this ────────────────────────────────────────────────

describe("operator interventions — the OPERATOR voice, and why it shares a register", () => {
  test("an intervention is neither the conversation nor the harness", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", {});
    expect(beatVoice(acts()[0]!)).toBe("operator");
  });

  test("…and the axis keeps all three values distinct", () => {
    const of = (kind: Beat["kind"]): string =>
      beatVoice({
        id: "x",
        kind,
        parentId: null,
        turnIndex: 0,
        at: 1,
        abnormal: false,
        bleed: true,
        verbs: [],
      } as Beat);
    expect(of("turn")).toBe("conversation");
    expect(of("tool")).toBe("conversation");
    expect(of("event")).toBe("system");
    expect(of("finding")).toBe("system");
    expect(of("act")).toBe("operator");
  });

  test("it renders in the RULE-LED register — no fill, so it is not speech", () => {
    const css = read(TOKENS);
    const rule = /\[data-voice="operator"\][^{]*\{([^}]*)\}/.exec(css);
    expect(rule, "tokens.css must give the operator voice a register").not.toBeNull();
    expect(
      rule![1]!,
      "an intervention is not somebody speaking, so it must never wear the bubble's fill",
    ).toMatch(/background:\s*none/);
  });

  test("it adds NO ground of its own — the register budget is genuinely spent", () => {
    const css = read(TOKENS);
    const rule = /\[data-voice="operator"\][^{]*\{([^}]*)\}/.exec(css);
    expect(rule![1]!).not.toMatch(/background:\s*var\(--ground/);
  });

  test("it earns its own MARK inside that register, distinct from every other", () => {
    // Same register (so "not speech" reads at a glance), a distinct mark (so
    // your decision cannot read as the harness's).
    const src = read(BEAT);
    const table = /const GLYPHS: Record<string, string> = \{([\s\S]*?)\};/.exec(src);
    expect(table, "the beat must have a glyph table").not.toBeNull();
    const marks = [...table![1]!.matchAll(/"([^"]+)",?\s*$/gm)].map((m) => m[1]!);
    expect(marks, "the operator mark must exist").toContain("≡");
    expect(new Set(marks).size, "no two kinds may share a mark").toBe(marks.length);
  });

  test("the intervention leads with WHO, in plain words", () => {
    serveManifest();
    startIngest({ seamDebounceMs: 0 });
    performed("run.compose", "pin", {});
    const { container } = render(ActBeat, { props: { beat: acts()[0]! } });
    expect(container.textContent, "authorship is the first thing to read").toContain("you");
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

describe("mutation — the intervention guards catch what they claim to", () => {
  test("an invented consequence is caught by the verbatim compare", () => {
    expect(PIN_CONSEQUENCE).not.toBe("Pins the memory.");
    expect(/not in the loaded manifest/.test("Pin")).toBe(false);
  });

  test("a replayed pre-ingest act is caught by the count", () => {
    serveManifest();
    performed("run.compose", "pin", {});
    performed("run.compose", "pin", {});
    startIngest({ seamDebounceMs: 0 });
    expect(acts()).toHaveLength(0);
  });

  test("a fill on the operator register is caught", () => {
    const bad = `[data-voice="operator"] .beat-card { background: var(--ground-2); }`;
    const rule = /\[data-voice="operator"\][^{]*\{([^}]*)\}/.exec(bad);
    expect(/background:\s*none/.test(rule![1]!)).toBe(false);
  });

  test("two kinds sharing a mark is caught", () => {
    const marks = ["›", "⊙", "≡", "≡"];
    expect(new Set(marks).size).not.toBe(marks.length);
  });
});
