// @vitest-environment jsdom
/**
 * THE FLOW'S CONSUMPTION OF THE RIGHT MENU'S ROW PATHS
 * (flow/beat-request.ts — the pane → flow one-shot seam).
 *
 * The seam's REQUEST half is pinned in
 * tests/cockpit/right-menu-row-path.test.ts (the store contract + the row
 * wiring). THIS file pins the CONSUMPTION half, against a real mounted
 * Flow: an externally-asked beat must land through the SAME functions the
 * flow's own controls run —
 *
 *   `scope`  → `openBeat`: the scope sheet request (component BeatScope,
 *              the beat itself, the causal-reference callback) + the beat
 *              focused, exactly what the `scope` grip and ⏎ produce;
 *   `reveal` → `focusAndReveal` + the inline depth ensured open: the
 *              focused beat is scrolled to and its card unfolded — the
 *              tool beats are sheetless by the beat-state ruling, so the
 *              inline depth IS the deep surface.
 *
 * An ask naming a beat the log does not hold is refused out loud (the
 * shell's hint), never scrolled to a guess.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup } from "@testing-library/svelte";
import { tick } from "svelte";
import { mount, unmount } from "svelte";

import Flow from "../../src/cockpit/flow/Flow.svelte";
import BeatScope from "../../src/cockpit/flow/BeatScope.svelte";
import { appendBeat, batch, clearLog } from "../../src/cockpit/flow/log.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";
import { requestBeatAction, consumeBeatRequest } from "../../src/cockpit/flow/beat-request.ts";
import type { ShellApi, ScopeRequest } from "../../src/cockpit/shell/contract.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function turnBeat(id: string, at: number): Beat {
  return {
    id,
    kind: "turn",
    parentId: null,
    turnIndex: 1,
    at,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who: "model", text: "the answer, committed", streaming: false },
  };
}

function toolBeat(id: string, parentId: string, at: number): Beat {
  return {
    id,
    kind: "tool",
    parentId,
    turnIndex: 1,
    at,
    abnormal: false,
    bleed: false,
    verbs: [],
    tool: {
      name: "read_file",
      label: "read file",
      status: "done",
      attemptCount: 1,
      durationMs: 120,
      input: { path: "a.ts" },
      output: null,
      startedAt: 2_400,
    },
  };
}

describe("the flow consumes the right menu's beat requests", () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | null = null;
  let opened: ScopeRequest[] = [];
  let hints: string[] = [];

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", RO);
    resetIngest();
    clearLog();
    consumeBeatRequest();
    opened = [];
    hints = [];
    // A recording stub over a permissive no-op base: the flow claims its
    // chords, parks its desk line and reads other shell seams while
    // mounted — none of those are this suite's subject, and the two that
    // ARE (openScope, hint) record their calls.
    // A callable that returns itself: shell seams that hand back an
    // unsubscribe (claimKey, pushDismiss, onComposerSubmit…) get a value
    // the flow can call at teardown, and chains of them stay callable.
    const self: (...args: unknown[]) => unknown = () => self;
    const base = new Proxy(
      {},
      {
        get: (_t, prop: string) => {
          if (prop === "openScope")
            return (req: ScopeRequest) => {
              opened.push(req);
            };
          if (prop === "hint")
            return (text: string) => {
              hints.push(text);
            };
          if (prop === "revealAt") return () => 0;
          return self;
        },
      },
    );
    const stub = base as unknown as ShellApi;
    target = document.createElement("div");
    document.body.appendChild(target);
    // FLOW IS AN OUTLET: it receives the shell as a PROP (§2 contract), not
    // from context — the stub rides the prop exactly the shell's own mount
    // would deliver it.
    app = mount(Flow, {
      target,
      props: { ingest: false, shell: stub },
    });
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    target.remove();
    cleanup();
    vi.unstubAllGlobals();
    clearLog();
    consumeBeatRequest();
  });

  test("a `scope` ask opens the beat's fact sheet through the flow's own openBeat", async () => {
    batch(() => {
      appendBeat(turnBeat("b-turn-1", 1_000));
    });
    await tick();
    requestBeatAction("b-turn-1", "scope");
    await tick();
    expect(opened).toHaveLength(1);
    const req = opened[0]!;
    expect(req.component).toBe(BeatScope);
    const props = req.props as { beat: Beat; onfocusbeat: unknown };
    expect(props.beat.id).toBe("b-turn-1");
    expect(typeof props.onfocusbeat).toBe("function");
    // The beat is focused too — the same side effect the flow's own scope
    // grip produces.
    expect(
      target.querySelector('[data-beat-id="b-turn-1"]')!.getAttribute("aria-selected"),
    ).toBe("true");
    // One ask, one trip: the consumption is one-shot.
    expect(consumeBeatRequest()).toBeNull();
  });

  test("a `reveal` ask focuses the beat and ensures its inline depth is open", async () => {
    batch(() => {
      appendBeat(turnBeat("b-turn-2", 2_000));
      appendBeat(toolBeat("b-call-2", "b-turn-2", 2_500));
    });
    await tick();
    const row = target.querySelector('[data-beat-id="b-call-2"]')!;
    expect(row.getAttribute("aria-selected")).toBe("false");
    requestBeatAction("b-call-2", "reveal");
    await tick();
    expect(
      target.querySelector('[data-beat-id="b-call-2"]')!.getAttribute("aria-selected"),
    ).toBe("true");
    // The reveal ensures the card is UNFOLDED — the tool beat's inline
    // depth is the deep surface (the beats are sheetless by the
    // beat-state ruling). An unfolded tool card offers its fold verb as
    // "collapse" (the resting, folded card offers "expand").
    expect(target.querySelector('[data-beat-id="b-call-2"]')!.textContent).toContain("Collapse");
  });

  test("an ask naming a beat the log does not hold is said out loud, never scrolled to a guess", async () => {
    batch(() => {
      appendBeat(turnBeat("b-turn-3", 3_000));
    });
    await tick();
    requestBeatAction("b-not-here", "scope");
    await tick();
    expect(opened).toHaveLength(0);
    expect(target.querySelector('[data-beat-id="b-turn-3"]')!.getAttribute("aria-selected")).toBe(
      "false",
    );
    expect(hints).toEqual([
      "that fact is not in this conversation's beats — nothing to jump to",
    ]);
  });
});
