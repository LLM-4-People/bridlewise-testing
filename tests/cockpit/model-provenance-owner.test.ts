// @vitest-environment jsdom
/**
 * WHERE A MODEL NAME ON SCREEN COMES FROM.
 *
 * Two surfaces name a model, and they answer two different questions:
 *
 *   THE DESK PICKER — "what will the NEXT turn run on". Its only honest
 *     sources are the chat's recorded model and, when the chat never chose,
 *     the served catalog's default (which is the same configured default the
 *     LLM bridge falls back to). NOT the global `selectedModelId` atom, which
 *     is not chat-scoped and therefore carries the previous conversation's
 *     pick into a conversation that never made one.
 *
 *   THE TURN FOOTER — "what ACTUALLY served this turn". Its only honest
 *     source is that turn's own record (`responseModel`, the model the
 *     provider named for that response). Reading the live picker here would
 *     rewrite history every time the user changed the dropdown: every past
 *     turn would claim to have been answered by whatever is selected now.
 *
 * The user found the first defect by suspicion ("I can pick something else
 * but it does not use it") rather than by reading it off the screen. Had the
 * turn footer been sourced from the picker, it would have agreed with the
 * picker and the disagreement would have stayed invisible forever. So both
 * directions are pinned here, and the picker-leak case is asserted as an
 * ABSENCE — no implementation that falls back to the live selection can pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

vi.mock("../../src/client.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getModels: vi.fn(async () => undefined),
    setChatModel: vi.fn(async () => undefined),
  };
});

import DeskPanel from "../../src/cockpit/desk/DeskPanel.svelte";
import TurnBeat from "../../src/cockpit/flow/TurnBeat.svelte";
import { setChatModel } from "../../src/client.ts";
import { resetDeskFeed, setDeskIo } from "../../src/cockpit/desk/desk-feed.ts";
import { resetDeskBus } from "../../src/cockpit/desk/desk-bus.ts";
import { currentChatId, resetChats, setChats } from "../../src/state/chats.ts";
import { clearMessages, setStreaming } from "../../src/state/chat-messages.ts";
import { resetModels, selectModel, setModels } from "../../src/state/models.ts";
import { clearCache } from "../../src/data/broker.ts";
import { returnToLive } from "../../src/data/asof.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";

const CHAT = "chat-1";

/** The model this conversation recorded. */
const RECORDED = "recorded-for-this-chat";
/** The served catalog's default — what the run uses when nothing was chosen. */
const SERVED_DEFAULT = "served-catalog-default";
/** A stale global selection, as if the user had picked it in ANOTHER chat. */
const LEFTOVER_PICK = "leftover-from-another-chat";

const COMPOSE = {
  channels: [
    { id: "system", tokens: 300, items: [{ id: "system-prompt", label: "system prompt — project context", tokens: 300 }] },
  ],
  limit: 10_000,
  settings: { pinnedMemoryIds: [], mutedChannels: [], mutedMemoryIds: [] },
};

function shellStub(): ShellApi {
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
    openScope: () => {},
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

/** Seed the chats store with one conversation carrying `modelId`. */
function seedChat(modelId: string | null): void {
  setChats([
    {
      id: CHAT,
      projectId: "p1",
      title: "reader",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-25T00:00:00Z",
      modelId,
      pinned: false,
    },
  ]);
  currentChatId.set(CHAT);
}

/** Seed the served catalog. `defaultModel: null` is the config-names-nothing case. */
function seedCatalog(defaultModel: string | null): void {
  setModels({
    providers: [
      {
        id: "prov",
        baseUrl: "http://x",
        models: [{ id: RECORDED }, { id: SERVED_DEFAULT }, { id: LEFTOVER_PICK }],
        hasApiKey: true,
      },
    ],
    defaultProvider: "prov",
    defaultModel,
    setupRequired: false,
    setupRemedy: "Open Settings and add a model provider.",
  });
}

/** A model turn as the record holds it. `responseModel` absent = the provider
 * never named one, which is a real state and must not be filled in. */
function modelTurn(responseModel?: string): Beat {
  return {
    id: "b-1",
    kind: "turn",
    at: Date.UTC(2026, 6, 25, 14, 2, 7),
    parentId: null,
    turn: {
      who: "model",
      text: "done.",
      streaming: false,
      inputTokens: 12,
      outputTokens: 3,
      ...(responseModel !== undefined ? { responseModel } : {}),
    },
  } as unknown as Beat;
}

beforeEach(() => {
  // The picker's write door asserts liveness. A file that planted the sweep
  // head and did not return leaves the whole worker in a past view, and this
  // suite would then fail with a refusal that has nothing to do with models.
  returnToLive();
  clearCache();
  resetDeskFeed();
  resetDeskBus();
  resetChats();
  resetModels();
  clearMessages();
  setStreaming(false);
  vi.mocked(setChatModel).mockClear();
  vi.mocked(setChatModel).mockResolvedValue(undefined);
  setDeskIo({ compose: async () => COMPOSE, breaker: async () => [], act: async () => ({}) });
});

afterEach(() => {
  cleanup();
  resetDeskFeed();
  resetDeskBus();
  resetChats();
  resetModels();
  clearMessages();
  setStreaming(false);
});

async function renderPicker(): Promise<HTMLSelectElement> {
  const { container, findByText } = render(DeskPanel, { shell: shellStub() });
  await findByText(/system prompt/i);
  return container.querySelector<HTMLSelectElement>("#desk-model")!;
}

describe("the desk picker names what the NEXT turn will run on", () => {
  test("the chat's recorded model wins over a leftover global selection", async () => {
    seedChat(RECORDED);
    seedCatalog(SERVED_DEFAULT);
    // As if the user had picked this in a different conversation.
    selectModel(LEFTOVER_PICK);

    expect((await renderPicker()).value).toBe(RECORDED);
  });

  /**
   * THE MUTATION-SENSITIVE CASE. This chat never chose a model, so the run
   * will use the served default. An implementation that falls back to the
   * live selection shows `LEFTOVER_PICK` here — a model this conversation's
   * next turn is not going to use — and this test is the only one that can
   * tell the difference.
   */
  test("a conversation that never chose shows the SERVED default, never the live selection", async () => {
    seedChat(null);
    seedCatalog(SERVED_DEFAULT);
    selectModel(LEFTOVER_PICK);

    const select = await renderPicker();
    expect(select.value).toBe(SERVED_DEFAULT);
    expect(select.value).not.toBe(LEFTOVER_PICK);
  });

  test("with nothing chosen and no configured default, the picker says so rather than naming the first model", async () => {
    seedChat(null);
    seedCatalog(null);
    selectModel(LEFTOVER_PICK);

    const select = await renderPicker();
    // A `<select>` with an unmatched value falls back to its first option —
    // which would name RECORDED as though someone had chosen it.
    expect(select.value).toBe("");
    expect(select.value).not.toBe(RECORDED);
    expect(select.selectedOptions[0]!.textContent).toMatch(/not chosen/i);
  });

  test("a refused write leaves the control on the recorded model and says why", async () => {
    seedChat(RECORDED);
    seedCatalog(SERVED_DEFAULT);
    vi.mocked(setChatModel).mockRejectedValue(new Error("the write was refused"));

    const select = await renderPicker();
    await fireEvent.change(select, { target: { value: SERVED_DEFAULT } });

    await waitFor(() => {
      // The control shows the model this conversation IS going to use, not
      // the one the user clicked and the server never accepted.
      expect(select.value).toBe(RECORDED);
    });
    expect(document.body.textContent).toContain("the write was refused");
  });

  test("an unresolved model choice excludes a second change and refusal restores the recorded choice", async () => {
    seedChat(RECORDED); seedCatalog(SERVED_DEFAULT);
    let reject!: (error: Error) => void;
    vi.mocked(setChatModel).mockReturnValue(new Promise((_, no) => { reject = no; }));
    const select = await renderPicker();
    await fireEvent.change(select, { target: { value: SERVED_DEFAULT } });
    expect(select.disabled).toBe(true);
    await fireEvent.change(select, { target: { value: RECORDED } });
    expect(vi.mocked(setChatModel)).toHaveBeenCalledTimes(1);
    reject(new Error("Held model selection refused"));
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe(RECORDED);
    expect(document.body.textContent).toContain("Held model selection refused");
  });

  /**
   * The selector used to live INSIDE the measured-composition branch, beside
   * the NEXT TURN total. A `run.compose` read that failed therefore removed
   * the control: the desk said "composition not measurable right now" and the
   * user lost the ability to choose what the next turn runs on — two unrelated
   * facts, one read's failure, both surfaces gone.
   */
  test("a failed composition read does not take the model control away", async () => {
    seedChat(RECORDED);
    seedCatalog(SERVED_DEFAULT);
    setDeskIo({
      compose: async () => { throw new Error("compose is down"); },
      breaker: async () => [],
      act: async () => ({}),
    });

    const { container, findByText } = render(DeskPanel, { shell: shellStub() });
    await findByText(/composition not measurable right now/i);

    const select = container.querySelector<HTMLSelectElement>("#desk-model");
    expect(select).not.toBeNull();
    expect(select!.value).toBe(RECORDED);
  });

  test("choosing a model writes it to the chat record — the fact the run route reads", async () => {
    seedChat(RECORDED);
    seedCatalog(SERVED_DEFAULT);

    const select = await renderPicker();
    await fireEvent.change(select, { target: { value: SERVED_DEFAULT } });

    await waitFor(() => {
      expect(vi.mocked(setChatModel)).toHaveBeenCalledWith(CHAT, SERVED_DEFAULT);
    });
  });
});

describe("a turn names the model that served IT, from its own record", () => {
  test("the footer shows the recorded model even when the picker says something else", () => {
    seedCatalog(SERVED_DEFAULT);
    selectModel(LEFTOVER_PICK);

    const { container } = render(TurnBeat, { beat: modelTurn(RECORDED) });

    expect(container.textContent).toContain(RECORDED);
    expect(container.textContent).not.toContain(LEFTOVER_PICK);
    expect(container.textContent).not.toContain(SERVED_DEFAULT);
  });

  /**
   * THE OTHER MUTATION-SENSITIVE CASE, and the reason this one is an
   * absence: a turn whose record names no model must name none. An
   * implementation that reads the live selection would print
   * `LEFTOVER_PICK` here and present the current dropdown as history.
   */
  test("a turn whose record names no model does not borrow the picker's", () => {
    seedCatalog(SERVED_DEFAULT);
    selectModel(LEFTOVER_PICK);

    const { container } = render(TurnBeat, { beat: modelTurn() });

    expect(container.textContent).not.toContain(LEFTOVER_PICK);
    expect(container.textContent).not.toContain(SERVED_DEFAULT);
  });

  test("changing the selection after the fact does not rewrite what a past turn says", async () => {
    seedCatalog(SERVED_DEFAULT);
    selectModel(RECORDED);

    const { container } = render(TurnBeat, { beat: modelTurn(RECORDED) });
    expect(container.textContent).toContain(RECORDED);

    // The user picks a different model for the NEXT turn. The turn already
    // recorded is untouched — history is not a function of the dropdown.
    selectModel(LEFTOVER_PICK);
    await waitFor(() => {
      expect(container.textContent).toContain(RECORDED);
    });
    expect(container.textContent).not.toContain(LEFTOVER_PICK);
  });
});
