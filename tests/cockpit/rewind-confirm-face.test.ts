// @vitest-environment jsdom
/**
 * THE REWIND CONFIRM'S RENDERED FACE FOLLOWS ITS ARM (UIE-043), rendered —
 * not asserted about in the abstract.
 *
 * Measured live: pressing `rewind here` on beat A renders the confirm
 * sentence beside A's verb; pressing `rewind here` on beat B RETARGETS the
 * one arm slot (nothing performs — safe) but A's sentence kept standing,
 * so two beats both said "press again" while one arm existed, and pressing
 * the stale one re-armed rather than performed. The binding the fix makes:
 * the confirm failure carries the arm's key, the slot is an observable
 * atom, and the rendered sentence derives from "does MY key still own the
 * slot" — so the retarget clears the abandoned face by reactivity.
 *
 * This file sits BESIDE the confirm's node-env owner
 * (tests/cockpit/flow-rewind-owner.test.ts) because the two halves need
 * different environments: the owner's arms are store-level (node), the
 * FACE is a rendered Svelte control (jsdom — vitest environments are
 * per-file). §41's edit-first rule was applied where it could be: the
 * confirmKey/atom arms EDIT the owner; only the rendered arm needs a file
 * of its own.
 *
 *   MUTATION: render `failure` unconditionally in Verb.svelte (drop the
 *   arm gate) → the "one face" assertions below fail with two faces.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import Verb from "../../src/cockpit/flow/Verb.svelte";
import { makeVerbsFor, type VerbContext } from "../../src/cockpit/flow/verbs.ts";
import { armedRewindConfirm } from "../../src/cockpit/flow/rewind.ts";
import { clearMessages } from "../../src/state/chat-messages.ts";
import { currentChatId } from "../../src/state/chats.ts";
import { resetContextStores } from "../../src/state/reset-all.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const CHAT = "chat-confirm-face";

/** The wire, stubbed: the rewind block-action POST and the `/history` GET
 * the perform path reloads through. */
function stubWire(): { rewindPosts: () => unknown[] } {
  const posts: unknown[] = [];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/b/run.compose/rewind")) {
        posts.push(typeof init.body === "string" ? JSON.parse(init.body) : init.body);
        return json({
          data: {
            eventId: "evt-face-1",
            anchorMessageId: "m-A",
            discardedMessageIds: ["m-A"],
            discarded: 1,
            promptForRerun: null,
          },
          meta: { etag: 'W/"1"', asOf: Date.now() },
        });
      }
      if (url.includes("/history")) {
        return json({
          chat: {
            id: CHAT,
            projectId: "p1",
            title: "face",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            modelId: null,
            pinned: false,
          },
          messages: [],
          toolCalls: [],
          metricsSnapshots: [],
          timelineRefs: [],
          page: { limit: 200, returned: 0, hasOlder: false, olderCursor: null, messageCount: 0, endedBy: "beginning" },
        });
      }
      return json({});
    }),
  );
  return { rewindPosts: () => posts };
}

function yourTurnBeat(messageId: string): Beat {
  return {
    id: `b-${messageId}`,
    kind: "turn",
    parentId: null,
    turnIndex: 0,
    at: 1,
    abnormal: false,
    bleed: true,
    verbs: [],
    turn: { who: "you", text: `the turn ${messageId}`, streaming: false },
  };
}

/** The `rewind here` verb of one persisted your-turn beat, rendered as a
 * live Verb control. */
function renderRewindVerb(messageId: string): { container: HTMLElement; button: HTMLButtonElement } {
  const ctx: VerbContext = {
    chatId: CHAT,
    projectId: "p1",
    toggleExpand: () => {},
    prefillComposer: () => {},
    hint: null,
    userPromptBefore: () => null,
  };
  const verbs = makeVerbsFor(ctx)(yourTurnBeat(messageId));
  const rewind = verbs.find((v) => v.id === "run.compose/rewind");
  if (rewind === undefined || rewind.wired !== true) {
    throw new Error(`the ${messageId} beat must carry a wired rewind here verb`);
  }
  const view = render(Verb, { props: { verb: rewind } });
  const button = view.container.querySelector<HTMLButtonElement>('button[data-verb-id="run.compose/rewind"]');
  if (button === null) throw new Error("the rewind verb must render a button");
  return { container: view.container, button };
}

const faces = (...containers: HTMLElement[]): HTMLElement[] =>
  containers.flatMap((c) => [...c.querySelectorAll<HTMLElement>(".verb-failure")]);

/** Let the control's async act() settle (the click handler's promise chain
 * crosses a couple of mocked-fetch microtasks). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetContextStores();
  clearMessages();
  currentChatId.set(CHAT);
  armedRewindConfirm.set(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  armedRewindConfirm.set(null);
  currentChatId.set(null);
});

describe("the retargeted arm clears the abandoned confirm face — one arm, one face", () => {
  test("arm A → retarget B → A's face is gone, B's renders; the perform clears both", async () => {
    const wire = stubWire();
    const a = renderRewindVerb("m-A");
    const b = renderRewindVerb("m-B");

    // Press A: the confirm arms A and A's face renders.
    a.button.click();
    await settle();
    expect(faces(a.container, b.container)).toHaveLength(1);
    expect(faces(a.container)[0]?.textContent).toContain("press again");

    // Retarget to B: the arm REPLACES, and A's face must FOLLOW the arm —
    // it no longer speaks for anything. One face total, B's.
    b.button.click();
    await settle();
    const afterRetarget = faces(a.container, b.container);
    expect(afterRetarget, "one arm means exactly one rendered confirm face").toHaveLength(1);
    expect(
      faces(a.container),
      "the abandoned target's sentence is not this control's to say anymore",
    ).toHaveLength(0);
    expect(faces(b.container)[0]?.textContent).toContain("press again");
    expect(wire.rewindPosts(), "a retarget performs nothing").toEqual([]);

    // Press B again within the window: the pair performs, the arm is
    // consumed, and every face clears with it.
    b.button.click();
    await settle();
    expect(wire.rewindPosts()).toHaveLength(1);
    expect(wire.rewindPosts()[0]).toMatchObject({ chatId: CHAT, toMessageId: "m-B", mode: "at" });
    expect(faces(a.container, b.container), "a performed arm owns no face").toHaveLength(0);
    expect(armedRewindConfirm.get()).toBeNull();
  });

  test("a confirm that still owns the arm keeps its face — the gate is not a blanket", async () => {
    // The mirror: without a retarget the face STAYS (the arm is still keyed
    // to this control), so the gate clears exactly the abandoned face and
    // nothing else. The second press here is an EXPIRED-window press: it
    // re-arms the same key (nothing performs — the drive's own
    // disarm-by-timeout proof), so the face legitimately stays.
    vi.useFakeTimers();
    try {
      stubWire();
      const a = renderRewindVerb("m-A");
      a.button.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(faces(a.container)).toHaveLength(1);

      // Ten seconds is the window; past it the arm is stale and the press
      // RE-ARMS the same key rather than performing.
      vi.setSystemTime(Date.now() + 10_001);
      a.button.click();
      await vi.advanceTimersByTimeAsync(0);

      expect(faces(a.container), "the same key re-armed — the face stays, exactly one").toHaveLength(1);
      expect(armedRewindConfirm.get()?.key).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
