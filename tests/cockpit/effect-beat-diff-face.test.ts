// @vitest-environment jsdom
/**
 * THE EFFECT BEAT'S DIFF FACE, RENDERED — honest words per measured fact.
 *
 * On a project with NO repository (measured live on the real millivolt-ideas
 * project, drive 11): a file the run had JUST created settled to
 * "Δ summary.md +0 −0 no uncommitted difference for this file right now (it
 * may have been committed or reverted since)" — the parenthetical names
 * commits and reverts that cannot exist where no repository is, and the
 * "+0 −0" is a measured-looking zero that measures nothing (the diff wire
 * answers an empty patch because there is no baseline, not because the
 * file matches one).
 *
 * This suite renders the beat through the REAL component and the REAL wire
 * decode against a stubbed fetch, and pins the three faces separately:
 *
 *   non-git        → the wire's own reason sentence; NO counts; never the
 *                    commit/revert story
 *   git, no diff   → the commit/revert sentence and the measured +0 −0 stand
 *                    (the repository-backed path is untouched)
 *   git, real diff → the counted ± and the laid-out patch stand
 *
 * WHERE THIS FILE WAS SEARCHED FOR BEFORE IT WAS WRITTEN: no existing guard
 * owns the beat's rendered diff words — flow-density owns layout,
 * flow-no-internal-ids owns addresses, response-grammar owns the Answer
 * grammar's own usage, and the custody suites own the SHEET's half of the
 * same wire. The beat's rendered face had no owner, so the face suite
 * stands beside the node-env owners of its halves
 * (cockpit-flow-verb-owner for the verb, custody-see-what-changed for the
 * bridge), the same split rewind-confirm-face made.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import EffectBeatProbe from "./fixtures/EffectBeatProbe.svelte";
import { appendBeat, clearLog } from "../../src/cockpit/flow/log.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const NON_GIT_REASON =
  "this project's folder is not under version control, so there is no earlier version to show changes against";

function effectBeat(id: string): Beat {
  return {
    id,
    kind: "effect",
    parentId: "b-11111111-1111-4111-8111-111111111111",
    turnIndex: 3,
    at: Date.UTC(2026, 8, 2, 10, 0, 0),
    abnormal: false,
    bleed: true,
    verbs: [],
    effect: { path: "summary.md", producedBy: "b-tool-1" },
  };
}

/** The diff-patch wire, stubbed per case. */
function stubDiffWire(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

function mount(): ReturnType<typeof render<typeof EffectBeatProbe>> {
  return render(EffectBeatProbe, {
    props: { initial: effectBeat("b-eff-nogit-1"), projectPath: "/tmp/millivolt-ideas" },
  });
}

afterEach(() => {
  cleanup();
  clearLog();
  vi.unstubAllGlobals();
});

describe("the non-git face — the wire's reason, no counts, no commit/revert story", () => {
  test("a no-repository answer renders the served sentence and never +0 −0", async () => {
    stubDiffWire({ patch: "", repository: false, reason: NON_GIT_REASON });
    appendBeat(effectBeat("b-eff-nogit-1"));
    const { container, findByText } = mount();
    expect(await findByText(NON_GIT_REASON)).toBeTruthy();
    const text = container.textContent ?? "";
    expect(text, "a zero count for an unmeasurable diff is a fabricated measurement").not.toContain("+0");
    expect(text).not.toContain("−0");
    expect(text, "no repository means no commit or revert can have happened").not.toContain("committed or reverted");
  });

  test("a no-repository answer that serves no reason falls back to the one owned sentence", async () => {
    // The defensive decode: the typed fact arrives, its words do not — the
    // same fallback the custody room holds for its own wire.
    stubDiffWire({ patch: "", repository: false });
    appendBeat(effectBeat("b-eff-nogit-1"));
    const { findByText } = mount();
    expect(await findByText("this project's folder is not under version control")).toBeTruthy();
  });
});

describe("the repository-backed faces — untouched by the non-git fix", () => {
  test("an empty patch on a real repository keeps its measured +0 −0 and its own sentence", async () => {
    stubDiffWire({ patch: "", repository: true });
    appendBeat(effectBeat("b-eff-nogit-1"));
    const { container, findByText } = mount();
    expect(await findByText("+0")).toBeTruthy();
    expect(
      await findByText(
        "no uncommitted difference for this file right now (it may have been committed or reverted since)",
      ),
    ).toBeTruthy();
    expect(container.textContent ?? "").not.toContain(NON_GIT_REASON);
  });

  test("a real patch keeps its counted ± and lays the change out", async () => {
    const patch = "--- a/summary.md\n+++ b/summary.md\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    stubDiffWire({ patch, repository: true });
    appendBeat(effectBeat("b-eff-nogit-1"));
    const { container, findByText } = mount();
    expect(await findByText("+2")).toBeTruthy();
    expect(container.textContent ?? "").toContain("one");
    expect(container.textContent ?? "").not.toContain(NON_GIT_REASON);
  });
});
