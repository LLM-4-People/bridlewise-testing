// @vitest-environment jsdom
/**
 * NO INTERNAL ID REACHES THE SCREEN — the blind spot, closed (§1.1).
 *
 * THE INSTANCE. A user opened a message's SCOPE sheet and pasted what it
 * showed, with the message "what is this":
 *
 *     caused by b-57bf9380-b910-47e9-a93d-7eb674e37942
 *
 * THE CLASS, which matters more than the instance. The existing
 * no-internal-vocabulary guard scans TEMPLATES, so it can only see strings
 * that are written literally in the markup. `b-57bf9380…` was never written
 * anywhere — it arrived at runtime through `{beat.parentId}`, and a template
 * scan is structurally incapable of catching that. The language agent
 * documented the blind spot; a sibling found the same shape for verb ids
 * bound at runtime.
 *
 * So this guard does not read source. It RENDERS every beat kind with
 * realistic fixtures — ids that look exactly like the real ones — and fails
 * if any internal address appears in the resulting text. A regression is
 * caught by the same mechanism that produced it: actual rendering.
 *
 * WHAT COUNTS AS AN INTERNAL ADDRESS is deliberately narrow, so the guard
 * says something true rather than something loud: bare UUIDs, the flow's own
 * `b-…`/`cd-…`/`seam-…` beat ids, run/trace ids, and snake_case identifiers.
 * A file PATH is not an address (`src/lib/file-91.ts` is exactly what the
 * user wants to see), and neither is a tool's registry name once it has been
 * put through `toolLabel`.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";

import BeatScope from "../../src/cockpit/flow/BeatScope.svelte";
import BeatView from "../../src/cockpit/flow/Beat.svelte";
import { appendBeat, clearLog } from "../../src/cockpit/flow/log.ts";
import { type Beat } from "../../src/cockpit/flow/types.ts";
import { toolLabel, setTools, resetTools } from "../../src/state/tools.ts";
import {
  resetEventDocuments,
  setEventDocumentsReader,
} from "../../src/state/timeline-event-documents.ts";
import type { WebToolEntry } from "../../shared/types.ts";

/**
 * The manifest entry the label derivation reads. `toolLabel` answers from
 * the served manifest's declared `label` — a renamed tool's label moves with
 * its registration, and no frontend table re-states it. The edit tool's own
 * registration declares "edit file".
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

// The label is derived from the served manifest; seed it before the fixtures
// below evaluate `toolLabel("edit")`.
setTools([EDIT_ENTRY]);

// ── The detector ───────────────────────────────────────────────────────────

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * Patterns that are ADDRESSES, not facts. Each is a shape a person can do
 * nothing with and was never meant to read.
 */
const ID_SHAPES: readonly { name: string; re: RegExp }[] = [
  { name: "beat id (b-<uuid>)", re: new RegExp(`\\bb-${UUID}`, "i") },
  { name: "bare uuid", re: new RegExp(`\\b${UUID}\\b`, "i") },
  { name: "run id", re: /\brun-[0-9a-z]{6,}/i },
  { name: "trace id", re: /\btrace-[0-9a-z]{6,}/i },
  { name: "synthetic beat id (cd-/seam-/…-fx)", re: /\b(?:cd-[\w-]{6,}|seam-\d+|b-msg-[\w-]+)/ },
  // A snake_case identifier is a key from the wire, not a phrase a person
  // writes. `edit` is the live edit tool's registry name; it must reach the
  // screen as its plain-words label, never as a wire key.
  { name: "snake_case identifier", re: /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/ },
];

/**
 * The text a reader can actually SEE.
 *
 * `textContent` returns everything in the subtree, including the body of a
 * CLOSED `<details>` — and the precise record is deliberately a closed
 * `<details>`, because the ids are real and must stay reachable one level
 * deeper. Counting them as "on screen" would fail the very design that
 * fixed the defect. jsdom computes no layout, so visibility is determined
 * structurally: a closed disclosure's body, and anything explicitly hidden,
 * is not visible.
 */
export function visibleText(root: Element): string {
  let out = "";
  for (const node of root.childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      out += node.textContent ?? "";
      continue;
    }
    if (!(node instanceof Element)) continue;
    if (node.hasAttribute("hidden")) continue;
    if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
      // Only the summary is on screen.
      const summary = node.querySelector("summary");
      out += summary?.textContent ?? "";
      continue;
    }
    out += ` ${visibleText(node)}`;
  }
  return out;
}

/** Every internal address visible in a rendered subtree's TEXT. */
export function renderedIds(text: string): string[] {
  const found: string[] = [];
  for (const { name, re } of ID_SHAPES) {
    const m = re.exec(text);
    if (m !== null) found.push(`${name}: "${m[0]}"`);
  }
  return found;
}

// ── Fixtures that look like the real thing ─────────────────────────────────

const PARENT_ID = "b-57bf9380-b910-47e9-a93d-7eb674e37942";
const SELF_ID = "b-9c1e40aa-2f77-4a10-8f2e-0b6ad1c5e3aa";

function beatOf(kind: Beat["kind"], extra: Partial<Beat> = {}): Beat {
  return {
    id: SELF_ID,
    kind,
    parentId: PARENT_ID,
    turnIndex: 3,
    at: Date.UTC(2024, 0, 1, 10, 23, 15),
    abnormal: false,
    bleed: kind !== "turn",
    verbs: [],
    ...extra,
  };
}

const FIXTURES: Readonly<Record<string, Beat>> = {
  "your message": beatOf("turn", {
    turn: { who: "you", text: "please refactor the reader path", streaming: false },
  }),
  "the assistant's reply": beatOf("turn", {
    turn: { who: "model", text: "I read the file and applied the change.", streaming: false },
  }),
  "a tool call": beatOf("tool", {
    tool: {
      name: "edit",
      // The label is DERIVED from the registry name through the real
      // `toolLabel` path — the very thing under test — never supplied as a
      // pre-baked answer. A renamed/removed tool that loses its label row
      // turns this into the fallback form and the guard notices.
      label: toolLabel("edit"),
      status: "done",
      input: { path: "src/lib/reader.ts" },
      output: "ok",
      startedAt: 1,
      durationMs: 42,
    },
  }),
  "a failed tool call": beatOf("tool", {
    abnormal: true,
    tool: {
      name: "read_file",
      label: "read file",
      status: "error",
      input: { path: "src/lib/reader.ts" },
      output: "no such file",
      startedAt: 1,
    },
  }),
  "a check result": beatOf("check-delta", {
    checkDelta: { checkId: "c1", checkName: "lint", from: "passed", to: "failed", errorCount: 2 },
  }),
  "a harness event": beatOf("event", {
    event: { eventKind: "bias", text: "the assistant leaned on one source" },
  }),
  // A RECORDED harness event — the transcript carries the canonical ledger
  // address (the live SSE timeline frames, a timeline ref, or persisted
  // metadata), so the sheet offers the documents fold. The address is a
  // real-shaped UUID on purpose: if it ever reaches a text node, the bare
  // uuid shape below catches it.
  "a recorded harness event": beatOf("event", {
    event: {
      eventKind: "bias",
      text: "the assistant leaned on one source",
      eventId: "9f2c31de-6b4e-4d5f-8a1c-77e20a53b0d2",
    },
  }),
};

const NOOP = {
  onfocusbeat: () => {},
  onstepbeat: () => {},
  onoverridebeat: () => {},
  onopenbeat: () => {},
  onexpandbeat: () => {},
  onmenubeat: () => {},
};

afterEach(() => {
  cleanup();
  clearLog();
  resetTools();
});

// ── The suite ──────────────────────────────────────────────────────────────

describe("no internal id is rendered — the SCOPE sheet", () => {
  for (const [name, beat] of Object.entries(FIXTURES)) {
    test(`${name}: the sheet shows no internal address`, () => {
      const { container } = render(BeatScope, { props: { beat, projectPath: null } });
      const text = visibleText(container);
      expect(text.length, "the sheet must render something").toBeGreaterThan(0);
      expect(
        renderedIds(text),
        `an internal address reached the screen — it means nothing to a person and cannot be ` +
          `acted on:\n${text}`,
      ).toEqual([]);
    });
  }

  test("the sheet says WHAT THIS IS in plain words, not 'turn'", () => {
    const { container } = render(BeatScope, {
      props: { beat: FIXTURES["your message"]!, projectPath: null },
    });
    const text = visibleText(container);
    expect(text).toContain("your message");
    // …and says it ONCE. The old sheet said "turn" in the cap, again as a
    // field, and again as a value.
    expect(text.match(/your message/g) ?? []).toHaveLength(1);
  });

  test("causality points at the THING and is clickable", () => {
    clearLog();
    appendBeat(
      beatOf("turn", {
        id: PARENT_ID,
        parentId: null,
        turn: { who: "you", text: "the causing message", streaming: false },
      }),
    );
    let focused: string | null = null;
    const { container, getByRole } = render(BeatScope, {
      props: {
        beat: FIXTURES["a tool call"]!,
        projectPath: null,
        onfocusbeat: (id: string) => {
          focused = id;
        },
      },
    });
    const text = visibleText(container);
    expect(text, "the cause is named as a thing, in plain words").toContain("in reply to your message");
    expect(renderedIds(text), "and still without the address").toEqual([]);
    const link = getByRole("button", { name: /in reply to your message/ });
    link.click();
    expect(focused, "following the causal chain is the point — it must be clickable").toBe(
      PARENT_ID,
    );
  });

  test("the precise record keeps the ids REACHABLE, one level deeper", () => {
    // They are real and someone will need them; they are just not the body.
    const { container } = render(BeatScope, {
      props: { beat: FIXTURES["a tool call"]!, projectPath: null },
    });
    const details = container.querySelector("details");
    expect(details, "the precise record must exist").not.toBeNull();
    expect(details!.open, "…and must be CLOSED at rest").toBe(false);
    expect(details!.textContent ?? "").toContain(SELF_ID);
  });
});

// ── The recorded documents fold ─────────────────────────────────────────────
//
// The fold is the honest surface for a RECORDED event's payload: it costs
// nothing closed, reads NOTHING until opened (the lazy read), renders the
// record's own documents name-agnostically through the public JSON door —
// and the canonical address that opened it is never on the screen.

describe("the recorded documents fold", () => {
  const RECORDED = FIXTURES["a recorded harness event"]!;
  const EVENT_ID = RECORDED.event!.eventId!;

  /**
   * Open (or reopen) a fold the way a real browser does: set the state,
   * then fire the `toggle` event the state change produces. (jsdom does not
   * synthesize `toggle` for a programmatic `open` set; the event is the
   * contract the component listens for, not the property mutation.)
   */
  function openFold(details: HTMLDetailsElement): void {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  }

  function closeFold(details: HTMLDetailsElement): void {
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
  }

  /** A reader that records calls and answers from a script. */
  function scriptedReader(script: readonly (readonly { name: string; content: unknown }[] | null | Error)[]) {
    const calls: string[] = [];
    let at = 0;
    const reader = async (eventId: string) => {
      calls.push(eventId);
      const answer = script[Math.min(at, script.length - 1)] ?? null;
      at += 1;
      if (answer instanceof Error) throw answer;
      return answer?.map((document) => ({ ...document, contentJson: document.content === null ? null : JSON.stringify(document.content), orderedJson: null, contentDigest: null })) ?? null;
    };
    return Object.assign(reader, { calls });
  }

  beforeEach(() => {
    resetEventDocuments();
  });

  afterEach(() => {
    setEventDocumentsReader((async () => {
      throw new Error("documents fold test: the live reader was reached");
    }) as never);
  });

  test("empty and JSON-null inline documents render while digest-only content remains absent", async () => {
    const previous = setEventDocumentsReader(async () => [
      { name: "empty", content: "", contentJson: "", orderedJson: null, contentDigest: "empty" },
      { name: "json-null", content: null, contentJson: "null", orderedJson: null, contentDigest: "null" },
      { name: "ordered-null", content: null, contentJson: null, orderedJson: "null", contentDigest: "ordered" },
      { name: "reference", content: null, contentJson: null, orderedJson: null, contentDigest: "reference" },
    ]);
    try {
      const { container } = render(BeatScope, { props: { beat: RECORDED, projectPath: null } });
      const fold = [...container.querySelectorAll("details")].find((element) => element.querySelector("summary")?.textContent?.includes("the recorded documents"))!;
      openFold(fold);
      await waitFor(() => expect(fold.querySelectorAll(".document")).toHaveLength(4));
      for (const document of [...fold.querySelectorAll(".document")].slice(0, 3)) {
        expect(document.textContent).not.toContain("recorded no content");
      }
      expect(fold.querySelectorAll(".document")[3]!.textContent).toContain("recorded no content");
    } finally { setEventDocumentsReader(previous); }
  });

  test("a recorded event offers the fold; it is CLOSED at rest and reads nothing", () => {
    const reader = scriptedReader([[{ name: "finding", content: { blocked: true } }]]);
    const prev = setEventDocumentsReader(reader as never);
    const { container } = render(BeatScope, { props: { beat: RECORDED, projectPath: null } });
    const fold = [...container.querySelectorAll("details")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").includes("the recorded documents"),
    );
    expect(fold, "a recorded event must offer its documents").toBeDefined();
    expect(fold!.open, "the fold is CLOSED at rest — the lazy read").toBe(false);
    expect(reader.calls, "an unopened fold has NOT read").toHaveLength(0);
    // And the closed sheet's visible text carries no address (the loop arm
    // above covers it too; this states it for the fold's own summary).
    expect(visibleText(container)).toContain("the recorded documents");
    setEventDocumentsReader(prev);
  });

  test("an event with NO recorded address offers NO fold (client-side errors were never recorded)", () => {
    const { container } = render(BeatScope, {
      props: { beat: FIXTURES["a harness event"]!, projectPath: null },
    });
    const fold = [...container.querySelectorAll("details")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").includes("the recorded documents"),
    );
    expect(fold).toBeUndefined();
  });

  test("opening the fold reads ONCE and renders the record's own documents — never the address", async () => {
    const reader = scriptedReader([
      [{ name: "finding", content: { blocked: true } }, { name: "verdict", content: "leaned" }],
    ]);
    const prev = setEventDocumentsReader(reader as never);
    const { container } = render(BeatScope, { props: { beat: RECORDED, projectPath: null } });
    const fold = [...container.querySelectorAll("details")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").includes("the recorded documents"),
    )!;

    openFold(fold);
    await waitFor(() => {
      expect(fold.textContent).toContain("finding");
      expect(fold.textContent).toContain("verdict");
    });
    expect(reader.calls).toEqual([EVENT_ID]);
    // The content itself rendered through the public JSON door.
    expect(fold.textContent).toContain("blocked");

    // THE ADDRESS NEVER REACHES THE SCREEN — not in the fold, not anywhere
    // in the sheet's subtree (the fold carries it as a store key, not text).
    expect(container.textContent).not.toContain(EVENT_ID);
    expect(renderedIds(fold.textContent ?? ""), "no address in the opened fold").toEqual([]);
    setEventDocumentsReader(prev);
  });

  test("the door's 404 absence is stated in the fold's own register, not as an error", async () => {
    const reader = scriptedReader([null]);
    const prev = setEventDocumentsReader(reader as never);
    const { container } = render(BeatScope, { props: { beat: RECORDED, projectPath: null } });
    const fold = [...container.querySelectorAll("details")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").includes("the recorded documents"),
    )!;
    openFold(fold);
    await waitFor(() => {
      expect(fold.textContent).toContain("not reachable");
    });
    setEventDocumentsReader(prev);
  });

  test("a failed read is stated with its retry — and reopening re-reads", async () => {
    const reader = scriptedReader([new Error("network down"), [{ name: "finding", content: null }]]);
    const prev = setEventDocumentsReader(reader as never);
    const { container } = render(BeatScope, { props: { beat: RECORDED, projectPath: null } });
    const fold = [...container.querySelectorAll("details")].find((d) =>
      (d.querySelector("summary")?.textContent ?? "").includes("the recorded documents"),
    )!;
    openFold(fold);
    await waitFor(() => {
      expect(fold.textContent).toContain("network down");
      expect(fold.textContent).toContain("retry");
    });
    // The honest retry: reopen (close + open) re-reads the failed fold.
    closeFold(fold);
    openFold(fold);
    await waitFor(() => {
      expect(fold.textContent).toContain("finding");
      expect(fold.textContent).toContain("recorded no content");
    });
    expect(reader.calls).toEqual([EVENT_ID, EVENT_ID]);
    setEventDocumentsReader(prev);
  });
});

describe("no internal id is rendered — the flow row, at every fisheye level", () => {
  for (const level of ["full", "ghost", "tick"] as const) {
    for (const [name, beat] of Object.entries(FIXTURES)) {
      test(`${name} at ${level}: no internal address on the row`, () => {
        const { container } = render(BeatView, {
          props: {
            beat,
            fisheye: { level, reason: `${level}: fixture` },
            focused: false,
            onChain: false,
            expanded: level === "full",
            projectPath: null,
            ...NOOP,
          },
        });
        const text = visibleText(container);
        expect(renderedIds(text), `an internal address reached the row:\n${text}`).toEqual([]);
      });
    }
  }
});

/**
 * A BEAT EITHER SAYS SOMETHING OR TAKES NO ROOM. There is no third option,
 * and this pair of guards owns the rule in both directions.
 *
 * THREE PASSES ON ONE ROW, and the last is the user's. An empty assistant
 * message rendered as an EMPTY BUBBLE ("it shows as empty turn in the chat").
 * We replaced it with an explanatory line plus the measured footer, arguing a
 * bare gap was worse than a sentence — and these tests asserted exactly that.
 * The user has now seen it and decided, verbatim: "this can just be hidden,
 * no need to show : the model returned nothing for this turn, the model acted
 * without commenting — its tool calls are below / ↑4,180 / ↓21 tok /
 * gemma-4-31b".
 *
 * THE ASSERTIONS BELOW ARE THEREFORE INVERTED, DELIBERATELY, and kept rather
 * than deleted — because BOTH failure modes must stay impossible:
 *
 *   - a beat that draws a row must never draw an EMPTY one (the original
 *     defect: a void the reader has to decode);
 *   - a beat with nothing to say must draw NO row at all (the new rule) —
 *     not a caption, not a footer, not a gutter segment.
 *
 * And the honesty condition that makes the second one legitimate: the
 * measurement is RELOCATED, never dropped. The turn's tokens and model are
 * still rendered in full one level deep, in the beat's SCOPE.
 */
describe("a beat either says something or takes no room", () => {
  const silentTurn = (extra: Record<string, unknown> = {}) =>
    beatOf("turn", { turn: { who: "model", text: "", streaming: false, ...extra } });

  const inFlow = (beat: Beat) =>
    render(BeatView, {
      props: {
        beat,
        fisheye: { level: "full", reason: "full: fixture" },
        focused: false,
        onChain: false,
        expanded: false,
        projectPath: null,
        ...NOOP,
      },
    }).container;

  test("a silent assistant turn draws NOTHING in the flow — no row, no caption", () => {
    const container = inFlow(
      silentTurn({ inputTokens: 6649, outputTokens: 1781, responseModel: "a-model" }),
    );
    expect(
      visibleText(container).trim(),
      "the user asked for this row to be hidden, not explained",
    ).toBe("");
    expect(
      container.querySelector(".beat"),
      "a hidden beat must not even emit its row wrapper — that is what makes it cost zero height",
    ).toBeNull();
  });

  test("a turn that produced nothing at all is hidden too (both cases go)", () => {
    expect(visibleText(inFlow(silentTurn())).trim()).toBe("");
  });

  test("…and the MEASUREMENT is relocated, not dropped: the SCOPE still has it", () => {
    // This is the condition that makes hiding honest rather than lossy.
    const { container } = render(BeatScope, {
      props: {
        beat: silentTurn({ inputTokens: 6649, outputTokens: 1781, responseModel: "a-model" }),
        projectPath: null,
      },
    });
    const text = visibleText(container);
    expect(text, "the measured tokens must survive one level deep").toContain("6,649");
    expect(text).toContain("a-model");
  });

  test("a turn that DOES say something still renders, and never renders empty", () => {
    // The original defect stays impossible in the other direction.
    const container = inFlow(
      beatOf("turn", { turn: { who: "model", text: "I read the file.", streaming: false } }),
    );
    expect(visibleText(container).trim()).not.toBe("");
    expect(container.querySelector(".bubble"), "a speaking turn is a bubble").not.toBeNull();
  });

  test("a STREAMING turn is never hidden, even before its first word", () => {
    // A row that appeared out of nowhere mid-stream would flicker.
    const container = inFlow(
      beatOf("turn", { turn: { who: "model", text: "", streaming: true } }),
    );
    expect(container.querySelector(".beat"), "a live turn holds its row").not.toBeNull();
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

describe("mutation — the runtime id detector catches what it claims to", () => {
  test("a beat id interpolated into a body is caught", () => {
    expect(renderedIds(`caused by ${PARENT_ID}`)).toHaveLength(2); // b-<uuid> and the uuid
  });

  test("a bare uuid is caught", () => {
    expect(renderedIds("57bf9380-b910-47e9-a93d-7eb674e37942").length).toBeGreaterThan(0);
  });

  test("a run id and a snake_case wire key are caught", () => {
    expect(renderedIds("run-9f2a71cc").length).toBeGreaterThan(0);
    // A snake_case wire key is an internal address; the live edit tool's
    // plain-words label ("edit file") must NOT be flagged as one.
    expect(renderedIds("edit_apply_patch").length).toBeGreaterThan(0);
  });

  test("the live edit tool renders as its plain-words label, never its registry name", () => {
    // The removed `edit_apply_patch` name pinned the FALLBACK path (its
    // `replaceAll("_"," ")` happens to produce no snake_case hit). The real
    // question this guard answers is what the SHIPPED tool renders as: the
    // single `edit` tool must reach the screen as "edit file" and never as a
    // wire key.
    const { container } = render(BeatView, {
      props: {
        beat: FIXTURES["a tool call"]!,
        fisheye: { level: "full", reason: "full: fixture" },
        focused: false,
        onChain: false,
        expanded: true,
        projectPath: null,
        ...NOOP,
      },
    });
    const text = visibleText(container);
    expect(text, "the edit tool call renders its plain-words label").toContain("edit file");
    expect(renderedIds(text), "no internal address reaches the row").toEqual([]);
  });

  test("a closed disclosure's body is NOT on screen (the ids stay reachable)", () => {
    const host = document.createElement("div");
    host.innerHTML = `<details><summary>the precise record</summary><dd>${PARENT_ID}</dd></details>`;
    expect(renderedIds(visibleText(host))).toEqual([]);
    (host.querySelector("details") as HTMLDetailsElement).open = true;
    expect(renderedIds(visibleText(host)).length).toBeGreaterThan(0);
  });

  test("a FILE PATH is not an address — the guard must not cry wolf", () => {
    expect(renderedIds("src/lib/reader.ts +16 −18")).toEqual([]);
    expect(renderedIds("your message at 10:23:15")).toEqual([]);
    expect(renderedIds("edit file · done · 42ms")).toEqual([]);
  });

  test("ordinary prose with hyphens and numbers is not an address", () => {
    expect(renderedIds("the assistant's reply — first word 1,098ms, 40.1 tok/s")).toEqual([]);
  });
});
