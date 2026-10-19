// @vitest-environment jsdom
/**
 * CONSECUTIVE TOOL CALLS READ AS ONE ACT OF WORK.
 *
 * THE USER'S REQUIREMENT, VERBATIM: "multiple tool calls in a row should be
 * batched and shown together."
 *
 * When the model reads three files and runs a command, that is ONE thing it
 * did with four parts. The flow drew four separate cards — four units in the
 * reading rhythm for one unit of meaning, and, collapsed, four rows of budget
 * where one would do.
 *
 * THE FOUR PROPERTIES PINNED HERE, each with a mutation self-check:
 *
 *   A. BOUNDARIES. A batch is a maximal run of adjacent tool beats and ends
 *      at the first beat of any other kind. This is the load-bearing half:
 *      prose, effects, checks, findings and operator interventions are
 *      exactly the beats that explain WHY the next batch happened, and
 *      swallowing one would destroy the causal reading the flow exists for.
 *   B. AGGREGATE AT REST. The batch states its count and its WORST member
 *      state, so a mixed batch can never read as clean.
 *   C. SMALLER ROWS, NOT FEWER ROWS. Compression buys a collapsed member's
 *      SIZE, never its EXISTENCE. This inverts an earlier pin ("three
 *      collapsed calls cost one row") that the user reported as a defect —
 *      see the long note above the block that enforces it.
 *   D. IDENTITY IS STABLE. A batch is identified by its FIRST member, so a
 *      call arriving at the end cannot change the identity, remount the DOM
 *      or force the virtualizer to re-measure. An earlier generation of this
 *      UI keyed a group on its members' JOINED IDS and hit exactly that.
 *
 * And the rule that had to keep holding: ABNORMALITY RESISTS COMPRESSION.
 * The two rules are not reconciled by either one knowing about the other —
 * the fisheye holds an abnormal beat at `full` on its own, so a batch with a
 * failure in it draws that failure whole while its quiet siblings compress
 * around it.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import BeatView from "../../src/cockpit/flow/Beat.svelte";
import { groupPlacements, groupSummary } from "../../src/cockpit/flow/grouping.ts";
import { fisheyeLevel } from "../../src/cockpit/flow/fisheye.ts";
import { clearLog } from "../../src/cockpit/flow/log.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import type { GroupPlace } from "../../src/cockpit/flow/grouping.ts";
import { read } from "../helpers/source-scan.ts";

const NOOP = {
  onfocusbeat: () => {},
  onoverridebeat: () => {},
  onopenbeat: () => {},
  onexpandbeat: () => {},
  onmenubeat: () => {},
};

let n = 0;
function tool(status: "running" | "done" | "error" = "done"): Beat {
  n += 1;
  return {
    id: `b-tool-${n}`,
    kind: "tool",
    parentId: null,
    turnIndex: 1,
    at: n,
    abnormal: status === "error",
    bleed: true,
    verbs: [],
    tool: {
      name: "read_file",
      label: "read file",
      status,
      input: { path: `src/f${n}.ts` },
      output: status === "error" ? "ENOENT" : "export const x = 1;",
      startedAt: 1,
    },
  };
}

function other(kind: Beat["kind"]): Beat {
  n += 1;
  return {
    id: `b-${kind}-${n}`,
    kind,
    parentId: null,
    turnIndex: 1,
    at: n,
    abnormal: false,
    bleed: kind !== "turn",
    verbs: [],
    ...(kind === "turn"
      ? { turn: { who: "model" as const, text: "I will read the files.", streaming: false } }
      : {}),
    ...(kind === "effect"
      ? { effect: { path: "src/f.ts", producedBy: "b-tool-1" } }
      : {}),
    ...(kind === "act"
      ? { act: { block: "run.compose", action: "pin", state: "done" as const, latencyMs: 4 } }
      : {}),
    ...(kind === "check-delta"
      ? { checkDelta: { checkId: "c", checkName: "lint", from: "passed", to: "passed" } }
      : {}),
    ...(kind === "event" ? { event: { eventKind: "steering" as const, text: "x" } } : {}),
  } as Beat;
}

afterEach(() => {
  cleanup();
  clearLog();
});

// ── A. Boundaries ──────────────────────────────────────────────────────────

describe("batching — a batch is adjacent tool calls, and stops at anything else", () => {
  test("three calls in a row are one batch", () => {
    const slice = [tool(), tool(), tool()];
    const places = groupPlacements(slice);
    expect(places.size).toBe(3);
    expect([...places.values()].every((p) => p.size === 3)).toBe(true);
    expect(places.get(slice[0]!.id)!.first).toBe(true);
    expect(places.get(slice[2]!.id)!.last).toBe(true);
  });

  for (const kind of ["turn", "effect", "check-delta", "event", "finding", "seam", "act"] as const) {
    test(`a ${kind} beat BREAKS the batch — it is why the next one happened`, () => {
      const a = tool();
      const b = tool();
      const c = tool();
      const d = tool();
      const places = groupPlacements([a, b, other(kind), c, d]);
      expect(places.get(a.id)!.groupId, "the first pair is its own batch").toBe(a.id);
      expect(places.get(a.id)!.size).toBe(2);
      expect(places.get(c.id)!.groupId, "the second pair is a DIFFERENT batch").toBe(c.id);
      expect(places.get(c.id)!.size).toBe(2);
    });
  }

  test("a lone tool call is not a batch at all", () => {
    const solo = tool();
    expect(groupPlacements([other("turn"), solo, other("turn")]).size).toBe(0);
  });

  test("a run that ends at the slice edge still groups", () => {
    const a = tool();
    const b = tool();
    expect(groupPlacements([other("turn"), a, b]).get(a.id)!.size).toBe(2);
  });
});

// ── B. The aggregate ───────────────────────────────────────────────────────

describe("batching — the batch states its count and its WORST state", () => {
  test("a mixed batch reads as FAILED, never as clean", () => {
    const slice = [tool("done"), tool("error"), tool("done")];
    const place = groupPlacements(slice).get(slice[0]!.id)!;
    expect(place.worst).toBe("alarm");
    expect(place.worstCount).toBe(1);
    expect(groupSummary(place)).toBe("3 × read file · 1 failed");
  });

  test("a batch still in flight reads as working, not as a result", () => {
    const slice = [tool("done"), tool("running")];
    const place = groupPlacements(slice).get(slice[0]!.id)!;
    expect(place.worst).toBe("working");
    expect(groupSummary(place)).toBe("2 × read file · 1 working");
  });

  test("a batch where everything settled reads as done", () => {
    const slice = [tool("done"), tool("done")];
    expect(groupSummary(groupPlacements(slice).get(slice[0]!.id)!)).toBe("2 × read file · all done");
  });

  test("a failure outranks everything (worst wins, in one place)", () => {
    const slice = [tool("running"), tool("error"), tool("done")];
    expect(groupPlacements(slice).get(slice[0]!.id)!.worst).toBe("alarm");
  });

  test("the cap is rendered ONCE, by the first member", () => {
    const slice = [tool(), tool(), tool()];
    const places = groupPlacements(slice);
    const caps = slice.map((beat) => {
      const { container } = render(BeatView, {
        props: {
          beat,
          fisheye: { level: "full", reason: "r" },
          focused: false,
          onChain: false,
          group: places.get(beat.id)!,
          expanded: false,
          projectPath: null,
          ...NOOP,
        },
      });
      return container.querySelector('[data-field="group-cap"]') !== null;
    });
    expect(caps, "exactly the first member draws the batch cap").toEqual([true, false, false]);
  });
});

// ── C. Compressed, a batch is SMALLER ROWS — never FEWER ROWS ──────────────
//
// THE DECISION THIS BLOCK REVERSES, recorded because it was deliberate both
// times. A compressed batch used to cost exactly ONE row: the first member
// drew the aggregate ("3 tool calls · all done") and the others rendered
// nothing at all. That read as the maximum expression of "batched and shown
// together", and it was tested here as "the whole point".
//
// THE USER LOOKED AT IT AND CALLED IT THE DEFECT: ten calls behind one line
// are ten facts you cannot see and never agreed to hide, on a surface whose
// standing rule is that the reader should not fear missing out. "Batched and
// shown together" asked for the run to read as ONE ACT — which the shared
// container, the closed-up rhythm and the unbroken causal spine deliver —
// not for nine of ten members to be replaced by a count.
//
// So the pin inverts: EVERY member draws its own row at every level, the
// first ALSO draws the cap, and what compression buys is the row's SIZE
// rather than its EXISTENCE.

describe("batching — compressed, every member still draws its own row", () => {
  const compressed = (beat: Beat, group: GroupPlace) =>
    render(BeatView, {
      props: {
        beat,
        fisheye: { level: "ghost", reason: "r" },
        focused: false,
        onChain: false,
        group,
        expanded: false,
        projectPath: null,
        ...NOOP,
      },
    }).container;

  test("every member draws a row — none is replaced by the cap", () => {
    const slice = [tool(), tool(), tool()];
    const places = groupPlacements(slice);
    const drawn = slice.map((b) => compressed(b, places.get(b.id)!).querySelector(".beat") !== null);
    expect(
      drawn,
      "a cap summarises rows that are THERE; a cap with nothing under it replaces them",
    ).toEqual([true, true, true]);
  });

  test("each member's row states ITS OWN call, readably, without a click", () => {
    // The rows are what the reader actually reads. Each one must carry the
    // call it belongs to — not the batch, and not a bare status mark.
    const slice = [tool("done"), tool("error")];
    const places = groupPlacements(slice);
    const first = compressed(slice[0]!, places.get(slice[0]!.id)!).textContent ?? "";
    const second = compressed(slice[1]!, places.get(slice[1]!.id)!).textContent ?? "";
    // Each row names its OWN target and its OWN recorded result.
    expect(first).toContain(slice[0]!.tool!.input!["path" as never] as unknown as string);
    expect(first).toContain("export const x = 1;");
    expect(second).toContain(slice[1]!.tool!.input!["path" as never] as unknown as string);
    expect(second).toContain("ENOENT");
    expect(first).not.toEqual(second);
  });

  test("the cap is still drawn, once, and still states the aggregate", () => {
    const slice = [tool("done"), tool("error")];
    const places = groupPlacements(slice);
    const caps = slice.map(
      (b) => compressed(b, places.get(b.id)!).querySelector('[data-field="group-cap"]') !== null,
    );
    expect(caps, "the cap belongs to the batch, and a batch has one").toEqual([true, false]);
    const text = compressed(slice[0]!, places.get(slice[0]!.id)!).textContent ?? "";
    // IDENTITY, not just a count: the cap names the tool when every member
    // called the same one. "2 tool calls · 1 failed" says how many questions
    // the reader still has; "2 × read file" answers one of them.
    expect(text).toContain("2 × read file");
    expect(text).toContain("1 failed");
  });

  test("a call that is NOT in a batch is unaffected", () => {
    const solo = tool();
    const { container } = render(BeatView, {
      props: {
        beat: solo,
        fisheye: { level: "ghost", reason: "r" },
        focused: false,
        onChain: false,
        group: null,
        expanded: false,
        projectPath: null,
        ...NOOP,
      },
    });
    expect(container.querySelector(".beat")).not.toBeNull();
    expect(container.textContent).toContain("read file");
  });
});

// ── The rules that had to keep holding ─────────────────────────────────────

describe("batching — abnormality still resists compression, without special-casing", () => {
  test("a failing member is held at FULL while its siblings compress", () => {
    // Neither rule knows about the other: the fisheye refuses to compress an
    // abnormal beat, so the failing call is the one drawn whole when space is
    // tight — which is exactly what the batch rule wanted.
    const failing = tool("error");
    const quiet = tool("done");
    const at = (beat: Beat) =>
      fisheyeLevel({ beat, focusTurnIndex: 40, onFocusChain: false, latestTurnIndex: 40 }).level;
    expect(at(failing)).toBe("full");
    expect(at(quiet)).not.toBe("full");
  });

  test("a member held at full still renders in full inside a batch", () => {
    const slice = [tool("done"), tool("error")];
    const places = groupPlacements(slice);
    const { container } = render(BeatView, {
      props: {
        beat: slice[1]!,
        fisheye: { level: "full", reason: "r" },
        focused: false,
        onChain: false,
        group: places.get(slice[1]!.id)!,
        expanded: false,
        projectPath: null,
        ...NOOP,
      },
    });
    expect(container.querySelector(".beat"), "a full member is never folded away").not.toBeNull();
    expect(container.textContent).toContain("ENOENT");
  });

  test("the symmetric-detail rule holds INSIDE a batch", () => {
    const slice = [tool("done"), tool("error")];
    const places = groupPlacements(slice);
    const fields = (beat: Beat) => {
      const { container } = render(BeatView, {
        props: {
          beat,
          fisheye: { level: "full", reason: "r" },
          focused: false,
          onChain: false,
          group: places.get(beat.id)!,
          expanded: false,
          projectPath: null,
          ...NOOP,
        },
      });
      return [...container.querySelectorAll("[data-field]")]
        .map((e) => e.getAttribute("data-field"))
        .filter((f) => f !== "group-cap");
    };
    expect(fields(slice[1]!), "grouping is composition, not a new asymmetry").toEqual(
      fields(slice[0]!),
    );
  });
});

// ── D. Identity ────────────────────────────────────────────────────────────

describe("batching — identity is the FIRST member, so a batch never remounts", () => {
  test("appending a call does not change the batch's id", () => {
    const a = tool();
    const b = tool();
    const before = groupPlacements([a, b]).get(a.id)!.groupId;
    const c = tool();
    const after = groupPlacements([a, b, c]).get(a.id)!.groupId;
    expect(after, "a streaming call must not re-identify the batch it joins").toBe(before);
    expect(after).toBe(a.id);
  });

  test("every member agrees on the id", () => {
    const slice = [tool(), tool(), tool()];
    const places = groupPlacements(slice);
    expect(new Set(slice.map((b) => places.get(b.id)!.groupId)).size).toBe(1);
  });

  test("the row keys are still per-BEAT, so no key can churn at all", () => {
    // The stronger property, and the reason the historical defect cannot
    // recur here: the flow never keys on a group, so a batch has no DOM
    // identity to destroy.
    expect(read("src/cockpit/flow/Flow.svelte")).toMatch(
      /\{#each win\.items as item \(item\.beat\.id\)\}/,
    );
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

describe("mutation — the batching guards catch what they claim to", () => {
  test("grouping ACROSS a prose turn is caught", () => {
    const a = tool();
    const b = tool();
    const wrong = groupPlacements([a, b, other("turn")]);
    // The turn is not a member, and the run that follows it is a new batch.
    expect(wrong.size).toBe(2);
  });

  test("a batch keyed on joined member ids WOULD churn (the historical defect)", () => {
    const a = tool();
    const b = tool();
    const c = tool();
    const joined = (xs: readonly Beat[]) => xs.map((x) => x.id).join("|");
    expect(joined([a, b])).not.toBe(joined([a, b, c]));
    // …whereas the first-member identity does not move.
    expect(groupPlacements([a, b]).get(a.id)!.groupId).toBe(
      groupPlacements([a, b, c]).get(a.id)!.groupId,
    );
  });

  test("a mixed batch reported as clean is caught", () => {
    const slice = [tool("done"), tool("error")];
    expect(groupSummary(groupPlacements(slice).get(slice[0]!.id)!)).not.toContain("all done");
  });
});

// ── E. A CAP NAMES WHAT WAS DONE, not only how much ────────────────────────
//
// THE USER'S REPORT, at the member level: "when collapsing further a tool
// call, we just have its checkmark, we lose the name and everything". The
// same defect exists one level up: `10 tool calls · all done` is a count and
// an outcome with no subject.

describe("batching — the cap keeps the batch's identity", () => {
  test("a run of one tool names that tool", () => {
    const slice = [tool(), tool(), tool()];
    expect(groupSummary(groupPlacements(slice).get(slice[0]!.id)!)).toBe(
      "3 × read file · all done",
    );
  });

  test("a run of DIFFERENT tools keeps the honest plural — no name is invented", () => {
    const a = tool();
    const b = tool();
    const mixed: Beat[] = [a, { ...b, tool: { ...b.tool!, label: "run command" } }];
    const place = groupPlacements(mixed).get(mixed[0]!.id)!;
    expect(place.sameTool, "mixed tools have no single true name (§1.1)").toBeNull();
    expect(groupSummary(place)).toBe("2 tool calls · all done");
  });

  test("mutation: naming a mixed batch after its first member would be a fabrication", () => {
    // The tempting shortcut. It reads fine and is false: nine `read file`
    // rows and one `delete` would cap as "10 × read file".
    const a = tool();
    const b = tool();
    const mixed: Beat[] = [a, { ...b, tool: { ...b.tool!, label: "run command" } }];
    const firstMemberName = mixed[0]!.tool!.label;
    expect(groupSummary(groupPlacements(mixed).get(mixed[0]!.id)!)).not.toContain(firstMemberName);
  });
});
