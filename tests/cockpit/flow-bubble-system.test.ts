// @vitest-environment node
/**
 * THE BEAT BUBBLE SYSTEM — three orthogonal axes, enforced (§1.1, §12.2).
 *
 * THE USER'S CORRECTIONS, VERBATIM:
 *
 *   "everything else that is not a chat (user/llm) is not very visible
 *    except when clicking on it. can it be a chat bubble that looks
 *    different depending on warning, success, error without having to click
 *    on it. we can still click to show maximum details."
 *
 *   "also what is sent by the harness (hallucination, bias, etc) should look
 *    different, so we can easily differentiate what the harness sends vs
 *    everything else."
 *
 * Three questions a reader asks at a glance, so three axes:
 *
 *   WHO   — side and alignment (owned by Beat.svelte);
 *   VOICE — conversation vs. the harness's own machinery. REGISTER only;
 *   STATE — success / warning / error / working. COLOUR only.
 *
 * They must stay ORTHOGONAL, which is what lets a harness-detected error and
 * a failed tool call both read as errors while still reading as different
 * voices. This suite pins the composition rule and the two disciplines that
 * keep it from becoming a zoo:
 *
 *   - COLOUR IS SPENT ON STATE AND NOWHERE ELSE. Every measured outcome earns
 *     a hue, on the same affordance, in the same weight: success green, error
 *     red, warning yellow, live beam.
 *
 *     THIS ASSERTION WAS INVERTED, DELIBERATELY. It used to read "and never
 *     on success", and it guarded a rule of ours that left `ok` uncoloured so
 *     the failures would keep jumping off the screen. The user decided
 *     otherwise, verbatim: "success green, error red, warning yellow." Their
 *     call wins, so the guard now requires the hue it used to forbid. This is
 *     a recorded DECISION, not drift — do not "restore" the old assertion;
 *     see beat-state.ts and the state-edge note in tokens.css.
 *
 *     What did NOT change is the discipline underneath: colour is still spent
 *     on STATE alone, and it is still the THIRD telling — every state keeps
 *     its glyph and its plain word, so nothing depends on hue.
 *   - VOICE ADDS NO GROUND. A fourth ground colour would push the palette
 *     past what the eye can sort, so the system voice is carried by register
 *     (no fill, a leading rule, the engraved mark) instead.
 *
 * And the legibility rule itself: state is readable AT REST at EVERY fisheye
 * level. Clicking is for depth, never for basic legibility.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, walk } from "../helpers/source-scan.ts";
import { styleBlock } from "../helpers/control-floor.ts";
import {
  beatState,
  beatVoice,
  stateWord,
  STATE_GLYPH,
  type BeatState,
} from "../../src/cockpit/flow/beat-state.ts";
import { fisheyeLevel } from "../../src/cockpit/flow/fisheye.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const TOKENS = "src/cockpit/tokens.css";
const BEAT = "src/cockpit/flow/Beat.svelte";

function beatOf(kind: Beat["kind"], extra: Partial<Beat> = {}): Beat {
  return {
    id: `b-${kind}`,
    kind,
    parentId: null,
    turnIndex: 0,
    at: 1,
    abnormal: false,
    bleed: true,
    verbs: [],
    ...extra,
  };
}

const tool = (status: "running" | "done" | "error", abnormal = false): Beat =>
  beatOf("tool", {
    abnormal,
    tool: { name: "read_file", label: "read file", status, input: {}, output: "", startedAt: 1 },
  });

// ── The state axis ─────────────────────────────────────────────────────────

describe("bubble system — STATE is read from the record, and only from it", () => {
  test("a tool call's state follows its recorded status", () => {
    expect(beatState(tool("error"))).toBe("alarm");
    expect(beatState(tool("running"))).toBe("working");
    expect(beatState(tool("done"))).toBe("ok");
  });

  test("a check delta's state follows the state it moved TO", () => {
    const check = (to: string): Beat =>
      beatOf("check-delta", { checkDelta: { checkId: "c", checkName: "lint", from: "passed", to } });
    expect(beatState(check("failed"))).toBe("alarm");
    expect(beatState(check("passed"))).toBe("ok");
  });

  test("the `abnormal` flag can only RAISE a state, never lower one", () => {
    // The flag is the record's own judgement. A kind with no opinion must
    // not talk it down, and a kind that already says "failed" must not be
    // softened to a warning by it.
    expect(beatState(tool("done", true))).toBe("warn");
    expect(beatState(tool("error", true))).toBe("alarm");
    expect(beatState(beatOf("turn", { abnormal: true }))).toBe("warn");
  });

  test("a beat with nothing to report says nothing (absence, not a green tick)", () => {
    expect(beatState(beatOf("turn"))).toBe("neutral");
    expect(stateWord("neutral")).toBeNull();
    expect(STATE_GLYPH.neutral).toBe("");
  });

  test("a turn whose run ended before any word was kept is a FAILURE of the turn", () => {
    // The stranded-tool settle reads the same way at its altitude (a tool
    // that never reported a result settles status "error" → alarm); an
    // interrupted turn is the same fact at the turn's — something was
    // asked for, nothing arrived, and the reader must see it failed.
    // MUTATION: drop the turn case in `ownState` and this reds with the
    // turn reading "neutral" — a dead turn wearing no state at all.
    const interrupted = beatOf("turn", {
      turn: { who: "model", text: "", streaming: false, incompleteReason: "the run ended before this answer was kept" },
    });
    expect(beatState(interrupted)).toBe("alarm");
    expect(stateWord("alarm")).toBe("failed");
    expect(beatState(beatOf("turn", { turn: { who: "model", text: "", streaming: false } }))).toBe("neutral");
  });

  test("every non-neutral state has BOTH a glyph and a plain word", () => {
    // The glyph carries it by form (colour-blind readers, distance); the
    // word carries it in language (nobody has to have learned a symbol).
    for (const s of ["working", "ok", "warn", "alarm"] as const) {
      expect(STATE_GLYPH[s].length, `${s} needs a glyph`).toBeGreaterThan(0);
      expect(stateWord(s), `${s} needs a word`).toBeTruthy();
    }
  });
});

// ── The legibility rule ────────────────────────────────────────────────────

describe("bubble system — state is legible AT REST, at every level", () => {
  const beatSrc = read(BEAT);
  const template = beatSrc.slice(0, beatSrc.indexOf("<style"));

  test("the GHOST row renders the status mark", () => {
    const ghost = /class="ghost-row"([\s\S]*?)<\/div>/.exec(template);
    expect(ghost, "the ghost row must exist").not.toBeNull();
    expect(ghost![1], "a ghost must state how the fact went").toContain("state-mark");
  });

  test("the TICK row renders the status mark too — the most compressed level", () => {
    const tick = /class="tick-row"([\s\S]*?)<\/div>/.exec(template);
    expect(tick, "the tick row must exist").not.toBeNull();
    expect(
      tick![1],
      "a tick you have to click to read the status of is the defect the user reported",
    ).toContain("state-mark");
  });

  test("the status mark carries the WORD as its title, not just a symbol", () => {
    expect(template).toMatch(/class="state-mark"[^>]*\stitle=\{stateLabel\}/);
  });

  test("the beat publishes both axes for the shared vocabulary to read", () => {
    expect(template).toContain("data-voice={voice}");
    expect(template).toContain("data-state={state}");
  });
});

// ── Abnormality resists compression ────────────────────────────────────────

describe("bubble system — an abnormal beat is never compressed away", () => {
  test("an abnormal beat renders FULL at every causal distance", () => {
    for (const distance of [0, 1, 2, 5, 20]) {
      const r = fisheyeLevel({
        beat: tool("error", true),
        focusTurnIndex: distance,
        onFocusChain: false,
        latestTurnIndex: distance,
      });
      expect(r.level, `an abnormal beat ${distance} turns away must stay full`).toBe("full");
    }
  });

  test("…and its state is never `ok` — the two rules agree about the same record", () => {
    // A guard that let an abnormal beat report success would make the
    // compression rule and the colour rule disagree about one fact.
    const states: BeatState[] = [
      beatState(tool("error", true)),
      beatState(tool("done", true)),
      beatState(beatOf("event", { abnormal: true, event: { eventKind: "bias", text: "x" } })),
    ];
    for (const s of states) expect(s === "warn" || s === "alarm").toBe(true);
  });
});

// ── The voice axis ─────────────────────────────────────────────────────────

describe("bubble system — VOICE separates the harness from the conversation", () => {
  test("the harness's own utterances are the system voice", () => {
    expect(beatVoice(beatOf("event", { event: { eventKind: "bias", text: "x" } }))).toBe("system");
    expect(beatVoice(beatOf("finding"))).toBe("system");
    expect(beatVoice(beatOf("seam"))).toBe("system");
  });

  test("the conversation — including the model's ACTIONS — is not", () => {
    for (const kind of ["turn", "tool", "effect", "check-delta"] as const) {
      expect(beatVoice(beatOf(kind)), `${kind} is somebody acting IN the conversation`).toBe(
        "conversation",
      );
    }
  });

  test("VOICE and STATE compose: a harness error reads as an error", () => {
    // Same state, different voice — which is the whole point of keeping the
    // axes orthogonal.
    const harnessError = beatOf("event", {
      event: { eventKind: "client-error", text: "x" },
    });
    expect(beatState(harnessError)).toBe("alarm");
    expect(beatVoice(harnessError)).toBe("system");
    expect(beatState(tool("error"))).toBe("alarm");
    expect(beatVoice(tool("error"))).toBe("conversation");
  });
});

// ── The two disciplines that keep it a system, not a zoo ───────────────────

describe("bubble system — colour is for STATE, and every outcome earns one", () => {
  const tokens = read(TOKENS);
  const vocab = /THE BEAT BUBBLE SYSTEM[\s\S]*?(?=\/\* ── The ONE global :focus-visible)/.exec(
    tokens,
  );

  test("the shared vocabulary exists and has one owner", () => {
    expect(vocab, "tokens.css must own the beat bubble system").not.toBeNull();
    expect(vocab![0]).toContain(".beat-card");
  });

  test("EVERY state earns hue, on the leading edge — success included", () => {
    // The `ok` row is the inverted assertion. It used to be forbidden here;
    // the user decided "success green, error red, warning yellow", so the
    // guard now requires it. See the module docstring above.
    for (const [state, token] of [
      ["ok", "--ok"],
      ["alarm", "--alarm"],
      ["warn", "--warn"],
      ["working", "--beam"],
    ] as const) {
      expect(vocab![0], `${state} must carry ${token}`).toMatch(
        new RegExp(`\\[data-state="${state}"\\][^{]*\\{[^}]*var\\(${token}\\)`),
      );
    }
  });

  test("the four states wear their hue the SAME WAY — siblings, not a zoo", () => {
    // A green success and a red error must differ in hue and in NOTHING else.
    // If one tinted the edge and another filled the card, the reader would be
    // learning two vocabularies for one idea.
    //
    // THIS ASSERTION MOVED UP A LEVEL, and the claim it makes is strictly
    // stronger than the one it replaces. It used to require each state to
    // paint `.beat-card` directly, which made the outcome vocabulary reach
    // exactly one element in one room — so the scheme was uniform inside the
    // flow and simply absent everywhere else, and this guard could not tell.
    // The states now declare ONE custom property and the flow consumes it, so
    // "siblings, not a zoo" is asserted about the mapping every surface reads
    // rather than about one room's border.
    const props = new Set<string>();
    for (const state of ["ok", "alarm", "warn", "working"]) {
      const rule = new RegExp(`\\[data-state="${state}"\\]\\s*\\{([^}]*)\\}`).exec(vocab![0]);
      expect(rule, `${state} must declare the outcome mapping`).not.toBeNull();
      for (const decl of rule![1]!.split(";")) {
        const name = decl.split(":")[0]?.trim();
        if (name !== undefined && name.length > 0) props.add(name);
      }
    }
    expect(
      [...props],
      "every state must set the same single property — differing only in hue",
    ).toEqual(["--outcome-ink"]);
  });

  test("the outcome mapping has exactly ONE consumer spelling, and it is not room-scoped", () => {
    // The half-application this replaced was invisible precisely because the
    // hue and its consumer were the same declaration: a surface outside the
    // flow could not read the mapping and nothing said so. Splitting them
    // means the consumer can be counted, and a SECOND consumer that re-derives
    // the hue from `--ok`/`--warn`/`--alarm` directly — the shape the old
    // arrangement forced on every new surface — is now a visible defect.
    const consumers = [...vocab![0].matchAll(/\[data-state\]\s*([^{]*)\{([^}]*)\}/g)];
    expect(consumers.length, "one consumer of --outcome-ink").toBe(1);
    expect(consumers[0]![2]!, "the consumer reads the mapping, not the hues").toContain(
      "var(--outcome-ink",
    );

    // And no rule may reach a semantic hue through a state selector any more:
    // that is the shape that made the scheme un-shareable.
    for (const token of ["--ok", "--warn", "--alarm", "--beam"]) {
      const direct = new RegExp(
        `\\[data-state[^{]*\\][^{]*\\{[^}]*(?:color|background)[^;}]*var\\(${token}\\)`,
      );
      expect(
        direct.test(vocab![0]),
        `no state rule may paint ${token} directly — it goes through --outcome-ink`,
      ).toBe(false);
    }
  });

  test("hue is the THIRD telling — the glyph and the word still carry it alone", () => {
    // The colour decision changed which states are coloured. It did not make
    // colour load-bearing: strip every hue and the state is still readable.
    for (const s of ["working", "ok", "warn", "alarm"] as const) {
      expect(STATE_GLYPH[s].length, `${s} must still have a glyph`).toBeGreaterThan(0);
      expect(stateWord(s), `${s} must still have a word`).toBeTruthy();
    }
  });

  test("VOICE adds NO ground — it is a register, not a fourth colour", () => {
    const systemRule = /\[data-voice="system"\][^{]*\{([^}]*)\}/.exec(vocab![0]);
    expect(systemRule, "the system voice must have a rule").not.toBeNull();
    expect(
      systemRule![1],
      "a fourth ground would push the palette past what the eye can sort; the system voice drops " +
        "the fill instead",
    ).toMatch(/background:\s*none/);
    expect(systemRule![1], "and it must not introduce a ground token of its own").not.toMatch(
      /background:\s*var\(--ground/,
    );
  });

  test("no instrument component re-declares a card ground of its own", () => {
    // Five identical copies of ground + hairline + radius + padding is five
    // chances for the family to drift apart.
    const offenders: string[] = [];
    for (const f of walk("src/cockpit/flow", { exts: [".svelte"] })) {
      const style = styleBlock(read(f));
      for (const cls of ["tool", "effect", "event", "delta"]) {
        const rule = new RegExp(`\\.${cls}\\s*\\{[^}]*background:\\s*var\\(--ground`);
        if (rule.test(style)) offenders.push(`${relpath(f)}: .${cls} declares its own ground`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

describe("mutation — the bubble-system guards catch what they claim to", () => {
  test("a success LEFT UNCOLOURED is caught (the inverted assertion bites)", () => {
    // The pre-decision behaviour: the `ok` edge rule simply absent.
    const before = `[data-state="alarm"] .beat-card { border-left-color: var(--alarm); }`;
    expect(/\[data-state="ok"\][^{]*\{[^}]*var\(--ok\)/.test(before)).toBe(false);
    const after = `[data-state="ok"] .beat-card { border-left-color: var(--ok); }`;
    expect(/\[data-state="ok"\][^{]*\{[^}]*var\(--ok\)/.test(after)).toBe(true);
  });

  test("a state that tints a DIFFERENT property than its siblings is caught", () => {
    const bad = `[data-state="ok"] .beat-card { background: var(--ok); }`;
    const rule = /\[data-state="ok"\] \.beat-card \{([^}]*)\}/.exec(bad);
    const props = rule![1]!
      .split(";")
      .map((d) => d.split(":")[0]?.trim())
      .filter((n): n is string => n !== undefined && n.length > 0);
    expect(props).not.toEqual(["border-left-color"]);
  });

  test("a system voice given a ground is caught", () => {
    const bad = `[data-voice="system"] .beat-card { background: var(--ground-3); }`;
    const m = /\[data-voice="system"\][^{]*\{([^}]*)\}/.exec(bad);
    expect(/background:\s*var\(--ground/.test(m![1]!)).toBe(true);
  });

  test("a component re-declaring its own ground is caught", () => {
    const style = `<style>.tool { background: var(--ground-1); }</style>`;
    expect(/\.tool\s*\{[^}]*background:\s*var\(--ground/.test(style)).toBe(true);
  });

  test("an abnormal beat compressed to a ghost is caught", () => {
    // The pre-fix behaviour: abnormal → ghost once past the focused turn.
    const r = fisheyeLevel({
      beat: tool("error", true),
      focusTurnIndex: 9,
      onFocusChain: false,
      latestTurnIndex: 9,
    });
    expect(r.level).not.toBe("ghost");
    expect(r.level).not.toBe("tick");
  });
});
