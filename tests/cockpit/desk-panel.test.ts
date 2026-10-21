// @vitest-environment jsdom
/**
 * THE OPEN DESK on screen (§3.4 CONTEXT DESK · §3.5 BREAKER PANEL).
 *
 * What must hold:
 *   - strips render the SERVED composition: measured bars (widths are the
 *     served share, asserted against the wire's own arithmetic), measured
 *     token counts, the NEXT TURN total/limit line and the model selector
 *     built from the models the SERVER serves;
 *   - a compose read that fails renders the strip column's honest absence
 *     ("composition not measurable right now …") and NO strips;
 *   - [pin]/[mute] post the declared block actions and the strip only
 *     changes after the read-back;
 *   - the trim handle's label is the FULL saved-conversation turn number
 *     and the number it SENDS is the number it SHOWED;
 *   - breaker rows carry the state chip, real counts and lastMs, the
 *     next-boundary consequence ON the control, [reset]/[why] when tripped,
 *     and `,` opens the arm sheet which posts `arm`;
 *   - the executing row glows ONLY while a call is genuinely in flight.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import DeskPanel from "../../src/cockpit/desk/DeskPanel.svelte";
import ChannelScope from "../../src/cockpit/desk/ChannelScope.svelte";
import Gauge from "../../src/cockpit/desk/Gauge.svelte";
import { SCOPE_BODY_FOLD_LINES } from "../../src/cockpit/desk/desk-config.ts";
import { resetDeskFeed, setDeskIo } from "../../src/cockpit/desk/desk-feed.ts";
import { resetDeskBus } from "../../src/cockpit/desk/desk-bus.ts";
import { currentChatId, resetChats, setChats } from "../../src/state/chats.ts";
import { clearMessages, setMessages, setStreaming } from "../../src/state/chat-messages.ts";
import { resetModels, setModels } from "../../src/state/models.ts";
import { clearCache } from "../../src/data/broker.ts";
import type { ShellApi, ScopeRequest } from "../../src/cockpit/shell/contract.ts";

const CHAT = "chat-1";

const COMPOSE = {
  channels: [
    { id: "system", tokens: 300, items: [{ id: "system-prompt", label: "system prompt — project context", tokens: 300 }] },
    {
      id: "memories",
      tokens: 100,
      items: [{ id: "mem-1", label: "[insight] prefers tabs", tokens: 100 }],
    },
    {
      id: "history",
      tokens: 600,
      items: [
        { id: "turn-1", label: "turn 1: fix the reader", tokens: 300 },
        { id: "turn-2", label: "turn 2: now the writer", tokens: 300 },
      ],
    },
    { id: "toolResults", tokens: 0, items: [] },
  ],
  limit: 10_000,
  settings: { pinnedMemoryIds: [], mutedChannels: [], mutedMemoryIds: [] },
};
const TOTAL = 1000;

const ROWS = [
  { id: "edit_file", label: "edit file", state: "on", calls: 12, lastMs: 3200 },
  { id: "web_fetch", label: "web fetch", state: "off", calls: 0 },
  {
    id: "search",
    label: "search",
    state: "tripped",
    calls: 7,
    lastError: "3 failures in a row",
    tripAfterFailures: 3,
  },
];

let scopeRequests: ScopeRequest[] = [];

function shellStub(): ShellApi {
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
    openScope: (req) => scopeRequests.push(req),
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
    pushDismiss: () => () => {},
    hint: () => {},
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: () => {},
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
  };
}

beforeEach(() => {
  scopeRequests = [];
  clearCache();
  resetDeskFeed();
  resetDeskBus();
  resetChats();
  resetModels();
  clearMessages();
  setStreaming(false);
  setChats([
    {
      id: CHAT,
      projectId: "p1",
      title: "reader",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-25T00:00:00Z",
      modelId: "claude-x",
      pinned: false,
    },
  ]);
  currentChatId.set(CHAT);
  setModels({
    providers: [
      {
        id: "prov",
        baseUrl: "http://x",
        models: [{ id: "claude-x" }, { id: "claude-y" }],
        hasApiKey: true,
      },
    ],
    defaultProvider: "prov",
    defaultModel: "claude-x",
    setupRequired: false,
    setupRemedy: "Open Settings and add a model provider.",
  });
});

afterEach(() => {
  cleanup();
  resetDeskFeed();
  resetDeskBus();
  resetChats();
  resetModels();
  clearMessages();
  setStreaming(false);
  vi.restoreAllMocks();
});

describe("channel strips — the served composition, measured (§3.4)", () => {
  test("bars are the served share; counts and the NEXT TURN line are served numbers", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });

    await findByText(/system prompt/i);
    const strips = container.querySelectorAll<HTMLElement>(".strip");
    expect(strips).toHaveLength(4);

    // Each bar's width is EXACTLY served tokens / served total.
    const widths = [...strips].map((s) => s.querySelector<HTMLElement>(".tick-fill")!.style.width);
    expect(widths).toEqual([
      `${(300 / TOTAL) * 100}%`,
      `${(100 / TOTAL) * 100}%`,
      `${(600 / TOTAL) * 100}%`,
      "0%",
    ]);

    // Token counts are the wire's numbers, not recomputed guesses.
    expect(container.textContent).toContain("300 tok");
    expect(container.textContent).toContain("600 tok");
    // NEXT TURN total / limit · percent (§3.4 bottom line).
    expect(container.textContent).toContain("1,000 / 10,000 tok");
    expect(container.textContent).toContain("10%");
  });

  test("the model selector offers the models the SERVER serves, selecting the chat's", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const select = container.querySelector<HTMLSelectElement>("#desk-model")!;
    expect([...select.options].map((o) => o.value)).toEqual(["claude-x", "claude-y"]);
    expect(select.value).toBe("claude-x");
  });

  test("a compose read that fails renders the column's honest absence and NO strips", async () => {
    setDeskIo({
      compose: async () => {
        throw new Error("down");
      },
      breaker: async () => ROWS,
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/composition not measurable right now/i);
    expect(container.textContent!.replace(/\s+/g, " ")).toContain(
      "the desk shows nothing rather than guessing",
    );
    expect(container.querySelectorAll(".strip")).toHaveLength(0);
    // The breaker column is unaffected — one failing read is not a blackout.
    expect(container.textContent).toContain("edit file");
  });

  /**
   * THE CHANNEL'S `[view]` CHIP IS GONE — inverted assertion, on purpose.
   *
   * THE USER'S DECISION, VERBATIM: "remove the view buttons in the desk, just
   * the clickable entries is enough." The channel row was already a click
   * path (its name opens the channel and lists what it serves), so a `[view]`
   * chip beside it was a second way to ask one question, landing on a
   * different surface. The test is kept and turned around rather than
   * deleted, so the chip cannot quietly come back.
   */
  test("the channel row carries NO [view] chip — its name is the click path", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const memoriesStrip = container.querySelector<HTMLElement>('[data-channel="memories"]')!;
    const head = memoriesStrip.querySelector<HTMLElement>(".row")!;
    expect(
      head.querySelector('[data-verb-id="desk.scope/view"]'),
      "one click, one outcome — the channel head must offer a single way in",
    ).toBeNull();
    // …and the way in is still there, still discoverable, still labelled.
    const open = head.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!;
    expect(open, "the channel name must be the control").not.toBeNull();
    await fireEvent.click(open);
    expect(
      [...memoriesStrip.querySelectorAll(".item-row")].length,
      "opening the channel must show what it is actually serving",
    ).toBe(1);
  });

  test("an opened channel that serves nothing SAYS so (the removed scope's sentence)", async () => {
    // Losing the chip must not lose the absence it used to state.
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const empty = container.querySelector<HTMLElement>('[data-channel="toolResults"]')!;
    await fireEvent.click(empty.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    expect(empty.textContent ?? "").toContain("carries nothing for the next reply");
  });

  test("[pin] posts the declared action; the strip changes only after the read-back", async () => {
    const posts: { block: string; action: string; input: Record<string, unknown> }[] = [];
    let composeWire: unknown = COMPOSE;
    setDeskIo({
      compose: async () => composeWire,
      breaker: async () => ROWS,
      act: async (block, action, input) => {
        posts.push({ block, action, input: { ...input } });
        // The action's own response says nothing to the screen.
        composeWire = { ...COMPOSE, settings: { ...COMPOSE.settings, pinnedMemoryIds: ["mem-1"] } };
        return { pinned: true };
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);

    const memories = container.querySelector<HTMLElement>('[data-channel="memories"]')!;
    await fireEvent.click(memories.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    const pin = await waitFor(() =>
      memories.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/pin"]')!,
    );
    await fireEvent.click(pin);

    expect(posts).toEqual([
      { block: "run.compose", action: "pin", input: { chatId: CHAT, channel: "memories", itemId: "mem-1" } },
    ]);
    // After the read-back the item reads back as pinned (from the READ), and
    // the control becomes the verb that TAKES IT BACK — a pin is undoable,
    // so the pinned state is never a dead-end label.
    await waitFor(() => {
      expect(
        memories.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/unpin"]')!.textContent,
      ).toContain("Unpin");
    });
    expect(memories.querySelector('[data-verb-id="run.compose/pin"]')).toBeNull();
  });

  test("[unpin] posts the declared action and the strip un-pins from the read-back", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    // Starts PINNED — the state the desk agent's stray pin left behind.
    let composeWire: unknown = {
      ...COMPOSE,
      settings: { ...COMPOSE.settings, pinnedMemoryIds: ["mem-1"] },
    };
    setDeskIo({
      compose: async () => composeWire,
      breaker: async () => ROWS,
      act: async (_block, action, input) => {
        posts.push({ action, input: { ...input } });
        composeWire = COMPOSE; // the read-back: no longer pinned
        return { pinned: false };
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);

    const memories = container.querySelector<HTMLElement>('[data-channel="memories"]')!;
    await fireEvent.click(memories.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    const unpin = await waitFor(() =>
      memories.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/unpin"]')!,
    );
    await fireEvent.click(unpin);

    expect(posts).toEqual([
      { action: "unpin", input: { chatId: CHAT, channel: "memories", itemId: "mem-1" } },
    ]);
    await waitFor(() => {
      expect(
        memories.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/pin"]')!.textContent,
      ).toContain("Pin");
    });
  });

  test("a MUTED channel's control is [unmute] — the mute is never a dead-end verb (UIE-009)", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    let finish: (() => void) | undefined;
    const held = new Promise<void>(resolve => { finish = resolve; });
    // Starts MUTED — the state the drive agent's channel mute left behind.
    let composeWire: unknown = {
      ...COMPOSE,
      settings: { ...COMPOSE.settings, mutedChannels: ["memories"] },
    };
    setDeskIo({
      compose: async () => composeWire,
      breaker: async () => ROWS,
      act: async (_block, action, input) => {
        posts.push({ action, input: { ...input } });
        await held;
        composeWire = COMPOSE; // the read-back: the channel is composed again
        return { muted: false };
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);

    const memories = container.querySelector<HTMLElement>('[data-channel="memories"]')!;
    // The muted channel's control BECOMES the way back — no disabled verb
    // wearing the title of the action it can no longer perform.
    const unmute = await waitFor(() =>
      memories.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/unmute"]')!,
    );
    expect(memories.querySelector('[data-verb-id="run.compose/mute"]')).toBeNull();
    expect(unmute.disabled).toBe(false);
    expect(unmute.getAttribute("title")).toContain("lifted at the next run anyway");
    unmute.focus();
    await fireEvent.click(unmute);
    await waitFor(() => expect(unmute.getAttribute("aria-disabled")).toBe("true"));
    expect(unmute.disabled, "pending retains native focus").toBe(false);
    expect(document.activeElement).toBe(unmute);
    await fireEvent.click(unmute);

    expect(posts).toEqual([
      { action: "unmute", input: { chatId: CHAT, channel: "memories" } },
    ]);
    finish!();
    // The read-back flips the control back to the muted-less state.
    await waitFor(() => {
      expect(
        memories.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/mute"]')!.getAttribute("aria-checked"),
      ).toBe("true");
    });
    expect(memories.querySelector('[data-verb-id="run.compose/unmute"]')).toBeNull();
    expect(memories.querySelector('[data-verb-id="run.compose/mute"]')).toBe(unmute);
    expect(document.activeElement).toBe(unmute);
  });

  test("a MUTED memory's control is [unmute], and it posts the declared action (UIE-009)", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    // Starts MUTED — and STILL LISTED, struck at 0 tokens: the real wire
    // shape (the composition read states what it withholds; it never makes
    // a muted memory silently vanish).
    const wireFor = (muted: boolean) =>
      muted
        ? {
            ...COMPOSE,
            channels: COMPOSE.channels.map((c) =>
              c.id === "memories"
                ? {
                    ...c,
                    items: c.items.map((i) => (i.id === "mem-1" ? { ...i, tokens: 0 } : i)),
                  }
                : c,
            ),
            settings: { ...COMPOSE.settings, mutedMemoryIds: ["mem-1"] },
          }
        : COMPOSE;
    let composeWire: unknown = wireFor(true);
    setDeskIo({
      compose: async () => composeWire,
      breaker: async () => ROWS,
      act: async (_block, action, input) => {
        posts.push({ action, input: { ...input } });
        composeWire = wireFor(false); // the read-back: the item is composed again
        return { muted: false };
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);

    const memories = container.querySelector<HTMLElement>('[data-channel="memories"]')!;
    await fireEvent.click(memories.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    // Scope to the ITEM's own row: the channel-level mute verb is still
    // live above it (only the item is muted), and both controls are
    // `run.compose/*` verbs — the row is the plane that changed.
    const itemRow = await waitFor(() => {
      const row = memories.querySelector<HTMLElement>("li.item")!;
      expect(row.querySelector('[data-verb-id="run.compose/unmute"]')).not.toBeNull();
      return row;
    });
    // The muted item is drawn struck through — the stated-absence mark.
    expect(itemRow.querySelector(".item-label")!.classList.contains("muted-label")).toBe(true);
    expect(itemRow.querySelector(".item-tokens")!.textContent).toContain("0 tok");
    expect(itemRow.querySelector('[data-verb-id="run.compose/mute"]')).toBeNull();
    const unmute = itemRow.querySelector<HTMLButtonElement>('[data-verb-id="run.compose/unmute"]')!;
    await fireEvent.click(unmute);

    expect(posts).toEqual([
      { action: "unmute", input: { chatId: CHAT, channel: "memories", itemId: "mem-1" } },
    ]);
    await waitFor(() => {
      expect(itemRow.querySelector('[data-verb-id="run.compose/mute"]')).not.toBeNull();
      expect(itemRow.querySelector('[data-verb-id="run.compose/unmute"]')).toBeNull();
      expect(itemRow.querySelector(".item-label")!.classList.contains("muted-label")).toBe(false);
    });
  });

  test("the trim handle SHOWS the full-conversation turn and SENDS that same number", async () => {
    const sent: number[] = [];
    // A recorded trim of 4 → the served window's turn 1 is full turn 4.
    const trimmed = { ...COMPOSE, settings: { ...COMPOSE.settings, trimBeforeTurn: 4 } };
    setDeskIo({
      compose: async () => trimmed,
      breaker: async () => ROWS,
      act: async (_b, _a, input) => {
        sent.push(input.beforeTurn as number);
        return {};
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);

    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    expect(container.textContent).toContain("Trim point ▸ turn 4");
    expect(slider.getAttribute("aria-valuenow")).toBe("4");
    // The range starts at the FULL conversation's turn 1, not at the current
    // point: a trim must be reversible from the same control (§3.4), so the
    // a11y contract states the real floor (UIE-010).
    expect(slider.getAttribute("aria-valuemin")).toBe("1");
    expect(slider.getAttribute("aria-valuemax")).toBe("5");

    // Keyboard-reachable: → moves the handle, ⏎ applies.
    await fireEvent.keyDown(slider, { key: "ArrowRight" });
    await waitFor(() => expect(container.textContent).toContain("Trim point ▸ turn 5"));
    await fireEvent.keyDown(slider, { key: "Enter" });
    // The number shown IS the number sent.
    await waitFor(() => expect(sent).toEqual([5]));
  });

  test("ArrowLeft below the current trim point DRAFTS A WIDENING — never a silently dead key (UIE-010)", async () => {
    const sent: number[] = [];
    // A recorded trim of 4: leftward from here used to clamp into a dead
    // key (the old min was the current point). Now it drafts turn 3 — a
    // real widening the action accepts — and ⏎ sends that same number.
    const trimmed = { ...COMPOSE, settings: { ...COMPOSE.settings, trimBeforeTurn: 4 } };
    setDeskIo({
      compose: async () => trimmed,
      breaker: async () => ROWS,
      act: async (_b, _a, input) => {
        sent.push(input.beforeTurn as number);
        return {};
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);

    const slider = container.querySelector<HTMLElement>('[role="slider"]')!;
    expect(container.textContent).toContain("Trim point ▸ turn 4");
    await fireEvent.keyDown(slider, { key: "ArrowLeft" });
    await waitFor(() => expect(container.textContent).toContain("Trim point ▸ turn 3"));
    expect(container.textContent).toContain("sends from turn 3");
    await fireEvent.keyDown(slider, { key: "Enter" });
    await waitFor(() => expect(sent).toEqual([3]));
    // Esc cancels a live widening draft without leaking to the ladder.
    await fireEvent.keyDown(slider, { key: "ArrowLeft" });
    await fireEvent.keyDown(slider, { key: "Escape" });
    await waitFor(() => expect(container.textContent).toContain("Trim point ▸ turn 4"));
    expect(sent).toEqual([3]);
  });

  test("history item labels are spelled in the same numbering the handle sends", async () => {
    const trimmed = { ...COMPOSE, settings: { ...COMPOSE.settings, trimBeforeTurn: 4 } };
    setDeskIo({ compose: async () => trimmed, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const history = container.querySelector<HTMLElement>('[data-channel="history"]')!;
    await fireEvent.click(history.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    await waitFor(() => {
      expect(history.textContent).toContain("turn 4: fix the reader");
      expect(history.textContent).toContain("turn 5: now the writer");
    });
  });
});

describe("breaker rows — served state, next-boundary consequence (§3.5)", () => {
  test("rows carry the state chip, real counts, lastMs and the tripped annunciator", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");

    const rows = container.querySelectorAll<HTMLElement>(".breaker-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(rows[0]!.querySelector('[role="switch"]')!.textContent?.trim()).toBe("");
    expect(rows[0]!.textContent).toContain("12 calls");
    expect(rows[0]!.textContent).toContain("last 3.2s");
    expect(rows[1]!.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
    expect(rows[1]!.querySelector('[role="switch"]')!.textContent?.trim()).toBe("");
    expect(rows[2]!.textContent).toContain("▲ Tripped");
    expect(rows[2]!.textContent).toContain("3 failures in a row");
    // The closed-desk summary fact is named on the panel header too.
    expect(container.textContent).toContain("tools 1/3");
  });

  test("[off] carries the consequence ON the control and posts set{at:next-boundary}", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    let wire: unknown = ROWS;
    setDeskIo({
      compose: async () => COMPOSE,
      breaker: async () => wire,
      act: async (_b, action, input) => {
        posts.push({ action, input: { ...input } });
        wire = ROWS.map((r) => (r.id === "edit_file" ? { ...r, state: "off" } : r));
        return { tool: "edit_file", on: false, effectiveAt: "next-boundary" };
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");

    const row = container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;
    const off = row.querySelector<HTMLButtonElement>('[data-verb-id="tools.breaker/set"]')!;
    expect(off.textContent?.trim()).toBe("");
    expect(off.getAttribute("aria-label")).toBe("Allow edit file to run");
    expect(off.getAttribute("aria-checked")).toBe("true");
    expect(off.getAttribute("title")).toContain(
      "takes effect at the next tool decision: a call already running finishes",
    );

    off.focus();
    await fireEvent.click(off);
    expect(posts).toEqual([
      { action: "set", input: { tool: "edit_file", on: false, at: "next-boundary" } },
    ]);
    // The chip confirms from the READ-BACK, never from the action response.
    await waitFor(() => expect(off.getAttribute("aria-checked")).toBe("false"));
    // …and the row's control is now the reciprocal [on].
    expect(off.textContent?.trim()).toBe("");
    expect(off.getAttribute("aria-label")).toBe("Allow edit file to run");
    expect(document.activeElement).toBe(off);
  });

  test("a refused flip states the refusal and leaves the chip alone", async () => {
    setDeskIo({
      compose: async () => COMPOSE,
      breaker: async () => ROWS,
      act: async () => {
        throw new Error("Only built-in tools have breakers");
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    const row = container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;
    await fireEvent.click(row.querySelector<HTMLButtonElement>('[data-verb-id="tools.breaker/set"]')!);
    await waitFor(() => expect(row.textContent).toContain("Only built-in tools have breakers"));
    expect(row.querySelector('[role="switch"]')!.getAttribute("aria-checked")).toBe("true");
    expect(row.querySelector('[role="switch"]')!.textContent?.trim()).toBe(""); // unchanged — nothing happened
  });

  test("a tripped row offers [reset] + [why]; why opens the recorded trip in the SCOPE", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("search");
    const row = container.querySelector<HTMLElement>('[data-tool="search"]')!;
    expect(row.querySelector('[data-verb-id="tools.breaker/reset"]')).not.toBeNull();
    await fireEvent.click(row.querySelector<HTMLButtonElement>('[data-verb-id="desk.scope/why"]')!);
    expect(scopeRequests).toHaveLength(1);
    expect(scopeRequests[0]!.title).toContain("why it tripped");
    expect((scopeRequests[0]!.props as { tool: string }).tool).toBe("search");
  });

  test("`,` on a row opens the trip-threshold sheet inline and arms the real action", async () => {
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    setDeskIo({
      compose: async () => COMPOSE,
      breaker: async () => ROWS,
      act: async (_b, action, input) => {
        posts.push({ action, input: { ...input } });
        return {};
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    const row = container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;

    await fireEvent.keyDown(row, { key: "," });
    const input = await waitFor(() => row.querySelector<HTMLInputElement>(".arm-input")!);
    await fireEvent.input(input, { target: { value: "5" } });
    row.querySelector<HTMLButtonElement>('.arm-sheet button[data-verb-id="tools.breaker/arm"]')!.focus();
    await fireEvent.click(
      row.querySelector<HTMLButtonElement>('.arm-sheet button[data-verb-id="tools.breaker/arm"]')!,
    );

    expect(posts).toEqual([{ action: "arm", input: { tool: "edit_file", tripAfterFailures: 5 } }]);
    await waitFor(() => expect(document.activeElement).toBe(row.querySelector(".tool-label")));
  });

  test("an ARMED row's sheet offers the disarm verb, and pressing it posts the real action", async () => {
    // THE WAY BACK (UIE-008): `arm` used to be the one-way door — the armed
    // threshold survived reset ("stays armed", deliberately) and the flip,
    // and no surface offered the clearing verb, so "not armed yet" was
    // unreachable once armed. The sheet now carries the two-way shape.
    // MUTATION: remove the disarm verb from the sheet and this fails at the
    // missing control.
    const posts: { action: string; input: Record<string, unknown> }[] = [];
    setDeskIo({
      compose: async () => COMPOSE,
      breaker: async () => ROWS,
      act: async (_b, action, input) => {
        posts.push({ action, input: { ...input } });
        return {};
      },
    });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("search");
    const row = container.querySelector<HTMLElement>('[data-tool="search"]')!;

    await fireEvent.keyDown(row, { key: "," });
    await waitFor(() => row.querySelector(".arm-input")!);
    expect(row.textContent?.match(/armed at 3/g)).toHaveLength(1);
    expect(row.textContent?.match(/7 calls/g)).toHaveLength(1);
    expect(row.querySelector(".arm-sheet .counts")).toBeNull();
    await fireEvent.click(
      row.querySelector<HTMLButtonElement>('.arm-sheet button[data-verb-id="tools.breaker/disarm"]')!,
    );
    expect(posts).toEqual([{ action: "disarm", input: { tool: "search" } }]);
  });

  test("a NOT-ARMED row's sheet offers no disarm — there is nothing to take back", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    const row = container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;
    await fireEvent.keyDown(row, { key: "," });
    await waitFor(() => row.querySelector(".arm-input")!);
    expect(row.querySelector(".arm-sheet .note")!.textContent).toBe("Not armed yet");
    expect(
      row.querySelector('button[data-verb-id="tools.breaker/disarm"]'),
      "a disarm with nothing armed is a dead control",
    ).toBeNull();
  });

  test("an armed row states the armed fact ON THE ROW — no sheet opened", async () => {
    // The row grammar owns its standing settings: the auto-trip materially
    // changes behavior (the tool switches itself off after N failures), and
    // a reader scanning the 33 rows could not see which tools were armed
    // without opening every `,` sheet. The row now carries the same words
    // the sheet uses. MUTATION: remove the armed chip from the row and both
    // assertions fail — the fact is sheet-only again.
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    const armedRow = container.querySelector<HTMLElement>('[data-tool="search"]')!;
    const chip = armedRow.querySelector('[data-field="breaker-armed"]');
    expect(chip, "the armed fact must be visible on the row itself").not.toBeNull();
    expect(chip!.textContent).toContain("armed at 3");
    // The un-armed rows carry no armed claim.
    const plainRow = container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;
    expect(plainRow.querySelector('[data-field="breaker-armed"]')).toBeNull();
  });

  test("the executing row glows ONLY while a call is genuinely in flight", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText("edit file");
    const row = () => container.querySelector<HTMLElement>('[data-tool="edit_file"]')!;
    expect(row().classList.contains("executing")).toBe(false);

    // A real running tool call on the shared run stream's store (setMessages
    // clears the streaming flag, so the live flag is set after the replace —
    // the same order the stream's own ingestion produces).
    setMessages([
      { id: "m1", role: "tool", content: "", timestamp: 1, toolCall: { id: "c1", name: "edit_file", input: { path: "a.ts" }, output: null, status: "running", startedAt: 1 } },
    ]);
    setStreaming(true);
    await waitFor(() => expect(row().classList.contains("executing")).toBe(true));
    await fireEvent.click(row().querySelector('.tool-label')!);
    expect(row().textContent?.match(/12 calls/g)).toHaveLength(1);
    expect(row().textContent?.match(/last 3\.2s/g)).toHaveLength(1);
    expect(row().querySelectorAll('.live-chip')).toHaveLength(1);

    // The call finishes → the glow dies with it (no timer, no phantom).
    setMessages([
      { id: "m1", role: "tool", content: "", timestamp: 1, toolCall: { id: "c1", name: "edit_file", input: { path: "a.ts" }, output: "ok", status: "done", startedAt: 1 } },
    ]);
    setStreaming(true);
    await waitFor(() => expect(row().classList.contains("executing")).toBe(false));

    // …and a dropped stream with a still-"running" record never glows on.
    setMessages([
      { id: "m1", role: "tool", content: "", timestamp: 1, toolCall: { id: "c1", name: "edit_file", input: { path: "a.ts" }, output: null, status: "running", startedAt: 1 } },
    ]);
    setStreaming(false);
    await waitFor(() => expect(row().classList.contains("executing")).toBe(false));
  });
});


// ── ITEM 2: THE ROW IS THE TARGET, and it LOOKS like one ───────────────────
//
// The user's report was that `[view]` did not bring more detail and should
// "just be clickable". Both halves are mechanical here: the row itself
// carries the click path, and the affordance that says so is in the DOM AT
// REST — a row that only reveals its openability on :hover fails, because a
// pointer that has not arrived yet cannot be taught anything.

describe("the strip item row opens its own detail", () => {
  test("the ROW carries the click path, and no separate chip duplicates it", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const history = container.querySelector<HTMLElement>('[data-channel="history"]')!;
    await fireEvent.click(history.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);

    const items = [...history.querySelectorAll<HTMLElement>("li.item")];
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) {
      const rows = li.querySelectorAll('[data-verb-id="desk.scope/view"]');
      // Exactly one view path per item, and it is the ROW element itself.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.classList.contains("item-row")).toBe(true);
      // The row wraps the item's own facts — it is the row, not a chip on it.
      expect(rows[0]!.querySelector(".item-label")).not.toBeNull();
      expect(rows[0]!.querySelector(".item-tokens")).not.toBeNull();
    }
  });

  test("the row's affordance is in the DOM BEFORE the pointer arrives", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const history = container.querySelector<HTMLElement>('[data-channel="history"]')!;
    await fireEvent.click(history.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);

    // No hover, no focus — the state a reader meets the row in.
    for (const row of history.querySelectorAll<HTMLElement>(".item-row")) {
      const mark = row.querySelector(".open-mark");
      expect(mark, "the row must show it opens before it is hovered").not.toBeNull();
      expect(mark!.textContent!.trim().length).toBeGreaterThan(0);
      // …and it says what the click does, for the pointer that pauses.
      expect(row.getAttribute("title")).toContain("words this puts into the next reply");
    }
  });

  test("clicking the row opens the SCOPE focused on THAT item", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    const history = container.querySelector<HTMLElement>('[data-channel="history"]')!;
    await fireEvent.click(history.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    scopeRequests.length = 0;

    const rows = [...history.querySelectorAll<HTMLButtonElement>(".item-row")];
    await fireEvent.click(rows[1]!);
    expect(scopeRequests).toHaveLength(1);
    const props = scopeRequests[0]!.props as {
      chatId: string;
      channel: string;
      focusItemId: string | null;
    };
    // The scope is told WHICH item and WHICH channel, so the body it opens
    // on is the row that was clicked — not the first one every time.
    expect(props.focusItemId).toBe("turn-2");
    expect(props.channel).toBe("history");
    expect(props.chatId).toBe(CHAT);
  });

  test("the scope carries what the per-item read needs — chat, channel, items", async () => {
    setDeskIo({ compose: async () => COMPOSE, breaker: async () => ROWS, act: async () => ({}) });
    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/system prompt/i);
    scopeRequests.length = 0;
    const memories = container.querySelector<HTMLElement>('[data-channel="memories"]')!;
    // The ENTRY is the click path now (the channel's `[view]` chip is gone —
    // see the inverted assertion above), so the per-item read is proven
    // through the row a person actually clicks.
    await fireEvent.click(memories.querySelector<HTMLButtonElement>('[data-verb-id="desk.strip/expand"]')!);
    await fireEvent.click(memories.querySelector<HTMLButtonElement>(".item-row")!);
    const props = scopeRequests[0]!.props as {
      chatId: string;
      channel: string;
      items: readonly { id: string }[];
    };
    // Without these three the scope cannot ask for a body at all, which is
    // exactly the state the report was about.
    expect(props.chatId).toBe(CHAT);
    expect(props.channel).toBe("memories");
    expect(props.items.map((i) => i.id)).toEqual(["mem-1"]);
  });
});


// ── ITEM 1: THE SCOPE SHOWS THE REAL COMPOSED TEXT ─────────────────────────
//
// The report: "a lot of the context desk thing have a view button that does
// not bring anymore details". It could not: `run.compose` serves only a
// label and a token count, so the scope could only repeat the row. These
// pin the fix END TO END on the client side — the scope reads the per-item
// body and renders THAT, or says plainly that it has none.

const HISTORY_ITEMS = [
  { id: "turn-1", label: "turn 1: fix the reader", tokens: 300 },
  { id: "turn-2", label: "turn 2: now the writer", tokens: 300 },
];

function scopeProps(overrides: Record<string, unknown> = {}) {
  return {
    shell: shellStub(),
    chatId: CHAT,
    channel: "history" as const,
    name: "history · 2 turns sent",
    items: HISTORY_ITEMS,
    totalTokens: 600,
    asOf: Date.UTC(2026, 6, 25, 12, 0, 0),
    focusItemId: "turn-2",
    ...overrides,
  };
}

const BODY = {
  channel: "history",
  itemId: "turn-2",
  label: "turn 2: now the writer",
  tokens: 300,
  origin: "the messages of this turn, exactly as they go on the wire (1 of them)",
  parts: [{ role: "user", field: "content", text: "now the writer, please" }],
  withheldChars: 0,
};

describe("the channel scope shows the REAL composed body", () => {
  test("it renders the served text, and the served origin with it", async () => {
    setDeskIo({ itemDetail: async () => BODY });
    const { container, findByText } = render(ChannelScope, scopeProps());
    // The words themselves — not the label, which the row already shows.
    await findByText(/now the writer, please/);
    expect(container.textContent).toContain("exactly as they go on the wire");
    // …and the cost of those exact words.
    expect(container.textContent).toContain("300 tok of the next reply");
  });

  test("it asks for the item the row named — not the first one every time", async () => {
    const asked: { channel: string; itemId: string }[] = [];
    setDeskIo({
      itemDetail: async (_c, channel, itemId) => {
        asked.push({ channel, itemId });
        return { ...BODY, itemId };
      },
    });
    render(ChannelScope, scopeProps());
    await waitFor(() => expect(asked.length).toBeGreaterThan(0));
    expect(asked[0]).toEqual({ channel: "history", itemId: "turn-2" });
  });

  test("MUTATION: a body the server did not send never appears", async () => {
    // The server says this item carries nothing. A surface that filled the
    // gap with a placeholder — "(empty)", a summary, the label again —
    // would be lying about what is being sent.
    setDeskIo({
      itemDetail: async () => ({
        ...BODY,
        parts: [],
        absence: "this result went out empty — there is no text to show",
      }),
    });
    const { container, findByText } = render(ChannelScope, scopeProps());
    await findByText(/went out empty/);
    // The row's own label is still there; a BODY is not.
    expect(container.querySelector(".item-body .part")).toBeNull();
    expect(container.textContent).not.toContain("now the writer, please");
  });

  test("a read that fails says so — it does not render an empty body", async () => {
    setDeskIo({
      itemDetail: async () => {
        throw new Error("connection lost");
      },
    });
    const { container, findByText } = render(ChannelScope, scopeProps());
    await findByText(/not readable right now/);
    expect(container.querySelector(".item-body .part")).toBeNull();
  });

  test("a body the decoder cannot trust is an absence, not a partial render", async () => {
    // `tokens` arrives as a string: the shape is not the served contract.
    setDeskIo({ itemDetail: async () => ({ ...BODY, tokens: "300" }) });
    const { container, findByText } = render(ChannelScope, scopeProps());
    await findByText(/did not carry a body this desk can show/);
    expect(container.textContent).not.toContain("now the writer, please");
  });

  test("a long body FOLDS with the remainder COUNTED — never a silent cut", async () => {
    const extra = 7;
    const lines = Array.from(
      { length: SCOPE_BODY_FOLD_LINES + extra },
      (_v, i) => `line ${i + 1}`,
    );
    setDeskIo({
      itemDetail: async () => ({
        ...BODY,
        parts: [{ role: "user", field: "content", text: lines.join("\n") }],
      }),
    });
    const { container, findByText } = render(ChannelScope, scopeProps());
    const more = await findByText(new RegExp(`${extra} more lines`));
    expect(more.getAttribute("data-verb-id")).toBe("desk.body/expand");
    // The hidden lines are hidden, not deleted: opening the fold shows them.
    await fireEvent.click(more);
    await waitFor(() =>
      expect(container.textContent).toContain(`line ${SCOPE_BODY_FOLD_LINES + extra}`),
    );
  });

  test("characters the SERVER withheld are counted on screen too", async () => {
    setDeskIo({ itemDetail: async () => ({ ...BODY, withheldChars: 4200 }) });
    const { findByText } = render(ChannelScope, scopeProps());
    await findByText(/4,200 more characters/);
  });

  test("every scope row is itself the click path, at the pointer floor", async () => {
    setDeskIo({ itemDetail: async () => BODY });
    const { container, findByText } = render(ChannelScope, scopeProps());
    await findByText(/now the writer, please/);
    const rows = [...container.querySelectorAll<HTMLElement>("li.item > .row")];
    expect(rows).toHaveLength(HISTORY_ITEMS.length);
    for (const row of rows) {
      expect(row.getAttribute("data-verb-id")).toBe("desk.scope/view");
      // The caret is drawn at rest — the row reads as openable unhovered.
      expect(row.querySelector(".caret")!.textContent!.trim().length).toBeGreaterThan(0);
      expect(row.getAttribute("aria-expanded")).toMatch(/true|false/);
    }
    // Exactly one row is open, and it is the one the strip focused.
    const open = rows.filter((r) => r.getAttribute("aria-expanded") === "true");
    expect(open).toHaveLength(1);
    expect(open[0]!.textContent).toContain("turn 2");
  });
});

describe("the two context labels carry distinguishing words", () => {
  test("the gauge says USED (measured, last composed request); the desk header says NEXT TURN — never the same bare word", () => {
    // Two surfaces one screen apart both spoke the bare word "context" for
    // different facts: the gauge's measured use versus the desk's
    // composition of the next request. Each must carry its own
    // distinguishing word, read from the source so a rename that
    // re-collides them fails here.
    const gauge = readFileSync(
      join(__dirname, "../../src/cockpit/desk/Gauge.svelte"),
      "utf8",
    );
    const panel = readFileSync(
      join(__dirname, "../../src/cockpit/desk/DeskPanel.svelte"),
      "utf8",
    );
    expect(gauge).toContain('>Context used<');
    expect(gauge).not.toMatch(/>context</i);
    expect(panel).toContain(">Next turn</span>");
  });
});

describe("the closed-desk context gauge — an absent percentage is ABSENCE", () => {
  const CONFINEMENT = {
    state: "confined",
    sentence: "commands reach this project only",
    reason: "the sandbox declares a project grant",
    measuredAt: 1,
  } as const;

  function gaugeFor(context: Readonly<{ contextTokens: number; contextTokenLimit: number }>): ReturnType<typeof render> {
    setDeskIo({
      breaker: async () => [],
      confinement: async () => CONFINEMENT,
    });
    setMessages([
      {
        id: "assistant-context",
        role: "assistant",
        content: "",
        timestamp: 1,
        context: {
          systemPrompt: "",
          toolNames: [],
          historyLength: 0,
          contextTokens: context.contextTokens,
          contextTokenLimit: context.contextTokenLimit,
        },
      },
    ]);
    return render(Gauge, { shell: shellStub() });
  }

  test("a limit that cannot give a share renders no percent, an explicit unavailable state, and NO fabricated 0% fill", async () => {
    // THE DEFECT THIS PINS: `contextPctOf` returns null for a 0-token limit,
    // and the gauge interpolated `${pct}%` (`null%`) while clamping
    // `pct ?? 0` into a 0%-wide bar. Absence must read as absence.
    const { container } = gaugeFor({ contextTokens: 5, contextTokenLimit: 0 });
    await waitFor(() => expect(container.textContent).toContain("Context used"));
    const text = container.textContent!.replace(/\s+/g, " ");
    expect(text, "a null percentage must never reach the wire as null%").not.toContain("null");
    expect(text, "no percent sign is invented when no share was measured").not.toContain("%");
    expect(text, "the measured token count is still shown").toContain("5 tok");
    expect(text).toContain("percentage unavailable");
    expect(container.querySelector(".tick-fill"), "a 0-width fill would fabricate 0%").toBeNull();
    expect(container.querySelector('[data-context-pct="unavailable"]')).not.toBeNull();
  });

  test("a measured pair still renders its share and its fill bar", async () => {
    // THE POSITIVE HALF: absence handling must not swallow a real reading.
    const { container } = gaugeFor({ contextTokens: 25, contextTokenLimit: 100 });
    await waitFor(() => expect(container.textContent).toContain("Context used"));
    const text = container.textContent!.replace(/\s+/g, " ");
    expect(text).toContain("25%");
    expect(text).not.toContain("percentage unavailable");
    const fill = container.querySelector<HTMLElement>(".tick-fill");
    expect(fill, "a measured pair draws its fill").not.toBeNull();
    expect(fill!.style.width).toBe("25%");
    expect(container.querySelector(".tick-track")!.getAttribute("aria-label")).toContain("context 25% of 100 tokens");
  });
});

test('quiet tools lead with name and state; counts and exact auto-trip stay reachable',async()=>{
  setDeskIo({compose:async()=>COMPOSE,breaker:async()=>[{id:'quiet-tool',label:'quiet tool',description:'Finds matching source. Supplied instructions stay exact.',state:'on',calls:0}],act:async()=>({})});
  const {container}=render(DeskPanel,{shell:shellStub()});
  await waitFor(()=>expect(container.querySelector('.breaker-row')).not.toBeNull());
  const row=container.querySelector('.breaker-row')!;
  expect(row.querySelector('.counts')).toBeNull();
  const state=row.querySelector('[role="switch"]')!;
  expect(state.getAttribute('aria-label')).toContain('Allow quiet');expect(state.getAttribute('aria-checked')).toBe('true');
  expect(state.textContent?.trim()).toBe('');
  expect(state.querySelector('.state-path')?.getAttribute('aria-hidden')).toBe('true');
  expect(container.textContent).toContain('Select a tool name for its description and auto-trip settings.');
  await fireEvent.click(row.querySelector('.tool-label')!);
  expect(row.querySelector('.arm-sheet')?.textContent).toContain('0 calls');
  expect(row.querySelector('input.arm-input')).not.toBeNull();
  expect(row.querySelector('.tool-label')?.getAttribute('aria-label')).toBe('About quiet tool');
  expect(row.querySelector('.tool-description')?.textContent).toBe('Finds matching source.');
  expect(row.querySelector('.tool-manual p')?.textContent).toBe('Supplied instructions stay exact.');
  await fireEvent.click(row.querySelector('.tool-manual summary')!);
  expect(row.querySelector('.tool-manual')?.hasAttribute('open')).toBe(true);
});
