// @vitest-environment jsdom
/**
 * MODEL PROVIDERS IN THE SETTINGS ROOM — the path out of the guided state.
 *
 * The cutover deleted the old tree's provider panel and ported nothing:
 * `saveModelPrefs` had ZERO consumers, the server routes survived unused,
 * and the refused run's own remedy ("Open Settings and add a model
 * provider") pointed at a room with no such control. This file pins the
 * section that closes that gap, at its contract:
 *
 *   - the guided state renders the SERVED remedy sentence (one owner);
 *   - add posts name, address, models and the typed key through
 *     `saveModelPrefs`, and the list repaints from the server's answer;
 *   - edit with a BLANK key field omits `apiKey` — the saved key is kept,
 *     never blanked and never round-tripped;
 *   - the key itself is never rendered — the list speaks `hasApiKey` only;
 *   - delete goes through the real DELETE wrapper, two presses;
 *   - test drives the real probe wrapper and renders the endpoint's own
 *     sentence;
 *   - each model is an editable ROW carrying its own settings (context
 *     window, max tokens, temperature) — the per-model surface the user
 *     asked for, with blank meaning "the provider decides".
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

vi.mock("../../src/client.ts", () => ({
  discoverModelProvider: vi.fn(async () => ({ ok: true, models: [] })),
  getModels: vi.fn(async () => CATALOG_EMPTY),
  saveModelPrefs: vi.fn(async () => ({ ok: true, prefs: CATALOG_ONE })),
  deleteModelProvider: vi.fn(async () => ({ ok: true, prefs: CATALOG_EMPTY })),
  testModelProvider: vi.fn(async () => ({
    ok: false,
    providerId: "local",
    modelId: "m-1",
    elapsedMs: 42,
    failureKind: "refused-key",
    detail: "the endpoint answered 401: bad key",
  })),
}));

import {
  discoverModelProvider,
  deleteModelProvider,
  saveModelPrefs,
  testModelProvider,
} from "../../src/client.ts";
import ProvidersSection from "../../src/cockpit/settings/ProvidersSection.svelte";
import { resetModels, setModels } from "../../src/state/models.ts";

const CATALOG_EMPTY = {
  providers: [],
  defaultProvider: null,
  defaultModel: null,
  setupRequired: true,
  setupRemedy:
    "No model provider is saved for this account, so there is nothing to send this run to. Open Settings and add a model provider: a name for it, the address of its API, your API key, and at least one model name it serves.",
};

const CATALOG_ONE = {
  providers: [
    { id: "local", baseUrl: "http://127.0.0.1:9999/v1", models: [{ id: "m-1" }], hasApiKey: true, headerNames: [] },
  ],
  defaultProvider: "local",
  defaultModel: "m-1",
  setupRequired: false,
  setupRemedy: "",
};

/** Two models under one provider — the default-picker subject. */
const CATALOG_TWO_MODELS = {
  providers: [
    {
      id: "local",
      baseUrl: "http://127.0.0.1:9999/v1",
      models: [{ id: "m-1" }, { id: "m-2" }],
      hasApiKey: true,
      headerNames: [],
    },
  ],
  defaultProvider: "local",
  defaultModel: "m-1",
  setupRequired: false,
  setupRemedy: "",
};

/** A provider whose stored model DECLARES its settings — the row subject. */
const CATALOG_WITH_MODEL_SETTINGS = {
  providers: [
    {
      id: "tuned",
      baseUrl: "http://127.0.0.1:9999/v1",
      models: [{ id: "m-1", contextWindow: 8192, maxTokens: 1024, temperature: 0.5 }],
      hasApiKey: true,
      headerNames: [],
    },
  ],
  defaultProvider: "tuned",
  defaultModel: "m-1",
  setupRequired: false,
  setupRemedy: "",
};

/** A provider carrying custom headers — the header-field subject. */
const CATALOG_WITH_HEADERS = {
  providers: [
    {
      id: "proxied",
      baseUrl: "http://127.0.0.1:9999/v1",
      models: [{ id: "m-1" }],
      hasApiKey: true,
      headerNames: ["X-Org-Id", "X-Route"],
    },
  ],
  defaultProvider: "proxied",
  defaultModel: "m-1",
  setupRequired: false,
  setupRemedy: "",
};

beforeEach(() => {
  resetModels();
  vi.mocked(discoverModelProvider).mockReset().mockResolvedValue({ok:true,models:[]});
  vi.mocked(saveModelPrefs).mockReset().mockResolvedValue({ok:true,prefs:CATALOG_ONE} as never);
  vi.mocked(deleteModelProvider).mockClear();
  vi.mocked(testModelProvider).mockClear();
});
afterEach(() => {
  cleanup();
  resetModels();
});

function field(container: HTMLElement, name: string): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  expect(el, name).not.toBeNull();
  return el!;
}

/** One input of one editable model row, by row index and field name. */
function rowInput(
  container: HTMLElement,
  row: number,
  fieldName: "model-id" | "model-context-window" | "model-max-tokens" | "model-temperature",
): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    `[data-model-row="${row}"] [data-field="${fieldName}"]`,
  );
  expect(el, `row ${row} field ${fieldName}`).not.toBeNull();
  return el!;
}

describe("the guided state", () => {
  test("no provider saved → the SERVED remedy sentence stands in the section", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    const remedy = container.querySelector('[data-field="provider-setup-remedy"]');
    expect(remedy).not.toBeNull();
    expect(remedy!.textContent).toContain("No model provider is saved");
    expect(container.textContent?.replace(/\s+/g, " ")).toContain("0 providers saved");
  });
});

describe("add", () => {
  test("the form posts name, address, per-model rows and the typed key; the list repaints from the answer", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    await fireEvent.input(field(container, "provider-name"), { target: { value: "local" } });
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:9999/v1" },
    });
    // The first model row exists already; give it a name and its context
    // window — the per-model fact the gauge and the trim honour.
    await fireEvent.input(rowInput(container, 0, "model-id"), { target: { value: "m-1" } });
    await fireEvent.input(rowInput(container, 0, "model-context-window"), {
      target: { value: "8192" },
    });
    // A second model, added by the row's own verb, with NO settings — blank
    // fields mean "the provider decides" and must be OMITTED, not zeroed.
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add-model"]')!);
    expect(document.activeElement).toBe(rowInput(container, 1, "model-id"));
    await fireEvent.input(rowInput(container, 1, "model-id"), { target: { value: "m-2" } });
    await fireEvent.input(field(container, "provider-api-key"), {
      target: { value: "throwaway-key-123" },
    });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveModelPrefs).toHaveBeenCalledWith({
        providers: [
          {
            id: "local",
            baseUrl: "http://127.0.0.1:9999/v1",
            models: [{ id: "m-1", contextWindow: 8192 }, { id: "m-2" }],
            apiKey: "throwaway-key-123",
          },
        ],
      });
    });
    // The store was fed by the wrapper in production; the mock's contract is
    // the same — feed it here and the list must repaint from it.
    setModels(CATALOG_ONE as never);
    await waitFor(() => {
      expect(container.querySelector('[data-provider="local"]')).not.toBeNull();
    });
    // The key value never renders anywhere; only its existence speaks.
    expect(container.textContent).not.toContain("throwaway-key-123");
    expect(container.querySelector('[data-has-key="true"]')!.textContent).toContain("Key saved");
  });
});

describe("edit", () => {
  test("a blank key field OMITS apiKey — the saved key is kept, never blanked", async () => {
    setModels(CATALOG_ONE as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    // The key field opens EMPTY: the saved key is never round-tripped.
    expect(field(container, "provider-api-key").value).toBe("");
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:8888/v1" },
    });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveModelPrefs).toHaveBeenCalledWith({
        providers: [
          {
            id: "local",
            baseUrl: "http://127.0.0.1:8888/v1",
            models: [{ id: "m-1" }],
            // no apiKey field at all — that is the keep-saved contract
          },
        ],
      });
    });
    const sent = vi.mocked(saveModelPrefs).mock.calls[0]![0];
    expect("apiKey" in sent.providers[0]!).toBe(false);
  });
});

describe("per-model settings — one editable row per model", () => {
  test("a stored model's own settings prefill its row and post back unchanged", async () => {
    setModels(CATALOG_WITH_MODEL_SETTINGS as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    // Each stored field surfaces as the row's own input — the per-model
    // facts are exposed, not implied.
    expect(rowInput(container, 0, "model-id").value).toBe("m-1");
    expect(rowInput(container, 0, "model-context-window").value).toBe("8192");
    expect(rowInput(container, 0, "model-max-tokens").value).toBe("1024");
    expect(rowInput(container, 0, "model-temperature").value).toBe("0.5");
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveModelPrefs).toHaveBeenCalledWith({
        providers: [
          {
            id: "tuned",
            baseUrl: "http://127.0.0.1:9999/v1",
            models: [{ id: "m-1", contextWindow: 8192, maxTokens: 1024, temperature: 0.5 }],
          },
        ],
      });
    });
  });

  test("a bare stored model opens as a row with BLANK fields — saved without loss", async () => {
    // The read-compat arm: providers saved before per-model settings existed
    // carry bare ids, and they must surface as rows with blank fields — an
    // immediate save posts them back as bare ids, so nothing is lost and
    // nothing is invented.
    setModels(CATALOG_ONE as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    expect(rowInput(container, 0, "model-id").value).toBe("m-1");
    expect(rowInput(container, 0, "model-context-window").value).toBe("");
    expect(rowInput(container, 0, "model-max-tokens").value).toBe("");
    expect(rowInput(container, 0, "model-temperature").value).toBe("");
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      const sent = vi.mocked(saveModelPrefs).mock.calls[0]![0];
      expect(sent.providers[0]!.models).toEqual([{ id: "m-1" }]);
    });
  });

  test("clearing a stored setting OMITS it — blank means the provider decides", async () => {
    setModels(CATALOG_WITH_MODEL_SETTINGS as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    await fireEvent.input(rowInput(container, 0, "model-context-window"), { target: { value: "" } });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      const sent = vi.mocked(saveModelPrefs).mock.calls[0]![0];
      expect(sent.providers[0]!.models[0]).toEqual({ id: "m-1", maxTokens: 1024, temperature: 0.5 });
      // Absent, not zero: the provider decides, and the write says so.
      expect("contextWindow" in sent.providers[0]!.models[0]!).toBe(false);
    });
  });

  test("a half-typed context window is a form error naming its model, never a write", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    await fireEvent.input(field(container, "provider-name"), { target: { value: "local" } });
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:9999/v1" },
    });
    await fireEvent.input(rowInput(container, 0, "model-id"), { target: { value: "m-1" } });
    await fireEvent.input(rowInput(container, 0, "model-context-window"), {
      target: { value: "8192.5" },
    });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="provider-form-note"]')?.textContent)
        .toContain('The context window for "m-1"');
    });
    expect(saveModelPrefs).not.toHaveBeenCalled();
  });

  test("a temperature outside 0–2 is a form error naming its model", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    await fireEvent.input(field(container, "provider-name"), { target: { value: "local" } });
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:9999/v1" },
    });
    await fireEvent.input(rowInput(container, 0, "model-id"), { target: { value: "m-1" } });
    await fireEvent.input(rowInput(container, 0, "model-temperature"), {
      target: { value: "3" },
    });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="provider-form-note"]')?.textContent)
        .toContain('the temperature for "m-1" must be between 0 and 2');
    });
    expect(saveModelPrefs).not.toHaveBeenCalled();
  });

  test("a row with numbers but no model name refuses rather than silently dropping them", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    await fireEvent.input(field(container, "provider-name"), { target: { value: "local" } });
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:9999/v1" },
    });
    // Name the FIRST row; leave the added second row nameless but typed-into.
    await fireEvent.input(rowInput(container, 0, "model-id"), { target: { value: "m-1" } });
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add-model"]')!);
    await fireEvent.input(rowInput(container, 1, "model-context-window"), {
      target: { value: "4096" },
    });
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="provider-form-note"]')?.textContent)
        .toContain("a model row needs its model name");
    });
    expect(saveModelPrefs).not.toHaveBeenCalled();
  });

  test("removing a model row drops it from the posted models", async () => {
    setModels(CATALOG_TWO_MODELS as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    // Two rows open; remove the second. The removal is the row's own verb,
    // one press — the form is unsaved, and cancel still walks it back.
    await fireEvent.click(
      container.querySelector('[data-model-row="1"] > [data-verb-id="models.provider/remove-model"]')!,
    );
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveModelPrefs).toHaveBeenCalledWith({
        providers: [
          {
            id: "local",
            baseUrl: "http://127.0.0.1:9999/v1",
            models: [{ id: "m-1" }],
          },
        ],
      });
    });
  });
});

describe("delete and test", () => {
  test("delete needs two presses and drives the real wrapper", async () => {
    setModels(CATALOG_ONE as never);
    const { container } = render(ProvidersSection);
    const del = container.querySelector('[data-verb-id="models.provider/delete"]')!;
    await fireEvent.click(del);
    expect(deleteModelProvider).not.toHaveBeenCalled();
    expect(del.textContent).toContain("press again");
    await fireEvent.click(del);
    await waitFor(() => expect(deleteModelProvider).toHaveBeenCalledWith("local"));
  });

  test("test renders the endpoint's own sentence, named by its failure class", async () => {
    setModels(CATALOG_ONE as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/test"]')!);
    await waitFor(() => {
      const note = container.querySelector('[data-field="provider-test-note"]');
      expect(note).not.toBeNull();
      // The class words come first — the reader learns WHAT happened before
      // the provider's own text names why.
      expect(note!.textContent).toContain("the saved key was refused");
      expect(note!.textContent).toContain("the endpoint answered 401: bad key");
    });
    expect(testModelProvider).toHaveBeenCalledWith("local");
  });

  test("an UNREACHABLE endpoint is named as such — never as a refusal", async () => {
    // The measured defect: a retrying probe surfaced the retry layer's own
    // cancellation phrasing ("refused — retry cancelled by caller") for a
    // dead address, so the reader who mistyped it learned that THEY
    // cancelled. The single-shot probe reports the first attempt's own
    // error, classed as no-answer, and the sentence says exactly that.
    // MUTATION: put the old `refused — {detail}` prefix back and the
    // "not as a refusal" assertion fails.
    vi.mocked(testModelProvider).mockResolvedValueOnce({
      ok: false,
      providerId: "local",
      modelId: "m-1",
      elapsedMs: 12,
      failureKind: "no-answer",
      detail: "network error: fetch failed",
    } as never);
    setModels(CATALOG_ONE as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/test"]')!);
    await waitFor(() => {
      const note = container.querySelector('[data-field="provider-test-note"]');
      expect(note).not.toBeNull();
      expect(note!.textContent).toContain("the endpoint did not answer");
      expect(note!.textContent).toContain("network error: fetch failed");
      expect(note!.textContent).not.toContain("refused");
    });
  });
});

describe("custom headers", () => {
  test("the form posts the parsed headers, and the list reports only their names", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    await fireEvent.input(field(container, "provider-name"), { target: { value: "proxied" } });
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:9999/v1" },
    });
    await fireEvent.input(rowInput(container, 0, "model-id"), { target: { value: "m-1" } });
    await fireEvent.input(
      container.querySelector<HTMLTextAreaElement>('textarea[name="provider-headers"]')!,
      { target: { value: "X-Org-Id: org-42\nX-Route: blue" } },
    );
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(saveModelPrefs).toHaveBeenCalledWith({
        providers: [
          {
            id: "proxied",
            baseUrl: "http://127.0.0.1:9999/v1",
            models: [{ id: "m-1" }],
            headers: { "X-Org-Id": "org-42", "X-Route": "blue" },
          },
        ],
      });
    });
    // The list repaints from the answer and reports the NAMES, never the
    // values — the values are secret-shaped and stay server-side.
    setModels(CATALOG_WITH_HEADERS as never);
    await waitFor(() => {
      expect(container.querySelector('[data-field="provider-headers"]')?.textContent)
        .toContain("2 extra headers");
    });
    expect(container.textContent).not.toContain("org-42");
  });

  test("a header line with no colon is a form error, never a write", async () => {
    setModels(CATALOG_EMPTY as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    await fireEvent.input(field(container, "provider-name"), { target: { value: "proxied" } });
    await fireEvent.input(field(container, "provider-base-url"), {
      target: { value: "http://127.0.0.1:9999/v1" },
    });
    await fireEvent.input(rowInput(container, 0, "model-id"), { target: { value: "m-1" } });
    await fireEvent.input(
      container.querySelector<HTMLTextAreaElement>('textarea[name="provider-headers"]')!,
      { target: { value: "not-a-header-line" } },
    );
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      expect(container.querySelector('[data-field="provider-form-note"]')?.textContent)
        .toContain("needs a colon");
    });
    expect(saveModelPrefs).not.toHaveBeenCalled();
  });

  test("editing preserves hidden header values without manufacturing incomplete draft lines", async () => {
    setModels(CATALOG_WITH_HEADERS as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    // The editor is prefilled with the NAMES — the values never round-trip.
    const headersEl = container.querySelector<HTMLTextAreaElement>('textarea[name="provider-headers"]')!;
    expect(headersEl.value).toBe("");
    expect(headersEl.parentElement?.textContent).toContain("X-Org-Id");
    expect(headersEl.parentElement?.textContent).toContain("X-Route");
    // Clearing it means "keep the saved set" — the write omits `headers`,
    // exactly as a blank key field omits `apiKey`. Asserted by re-saving with
    // an EMPTY headers field after clearing the prefill.
    await fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => {
      const sent = vi.mocked(saveModelPrefs).mock.calls[0]![0];
      expect("headers" in sent.providers[0]!).toBe(false);
    });
  });
});

describe("the default model is changeable from one section control", () => {
  test("the selected provider and model are canonical and share one control", async () => {
    setModels(CATALOG_TWO_MODELS as never);
    const { container } = render(ProvidersSection);
    const pick = container.querySelector<HTMLSelectElement>('[name="provider-default-model"]')!;
    expect(pick.value).toBe(JSON.stringify(["local", "m-1"]));
    expect(container.querySelectorAll('[data-verb-id="models.default/set"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("Make default");
    await fireEvent.change(pick, { target: { value: JSON.stringify(["local", "m-2"]) } });
    await waitFor(() => expect(saveModelPrefs).toHaveBeenCalledWith({ providers: [], defaultProvider: "local", defaultModel: "m-2" }));
  });
  test("a failed default remains visible without an editor; pending changes cannot overlap", async () => {
    let refuse!: (error: Error) => void;
    vi.mocked(saveModelPrefs).mockImplementationOnce(() => new Promise((_resolve, reject) => { refuse = reject; }));
    setModels(CATALOG_TWO_MODELS as never);
    const { container } = render(ProvidersSection);
    const pick = container.querySelector<HTMLSelectElement>('[name="provider-default-model"]')!;
    await fireEvent.change(pick, { target: { value: JSON.stringify(["local", "m-2"]) } });
    await fireEvent.change(pick, { target: { value: JSON.stringify(["local", "m-2"]) } });
    expect(saveModelPrefs).toHaveBeenCalledTimes(1);
    refuse(new Error("default choice refused"));
    await waitFor(() => expect(container.textContent).toContain("default choice refused"));
    expect(container.querySelector("form")).toBeNull();
    expect(pick.value).toBe(JSON.stringify(["local", "m-1"]));
  });
});

describe("the section is plugged into the room", () => {
  test("SettingsRoom mounts ProvidersSection — an unconsumed section cannot pass", async () => {
    // The defect this whole surface answers was an unconsumed capability;
    // the section must not be able to repeat it one level up.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(__dirname, "../../src/cockpit/rooms/SettingsRoom.svelte"),
      "utf8",
    );
    expect(source).toContain("<ProvidersSection");
    expect(
      source,
      "search must not unmount the section — a rail jump to Model providers would find nothing",
    ).not.toMatch(/\{#if !searching\}[\s\S]*?<ProvidersSection/);
  });
});

describe("Provider form completion and probe ownership", () => {
  test.each([
    ["provider-base-url", "http://127.0.0.1:9999/newer"],
    ["provider-api-key", "newer-key"],
    ["provider-headers", "X-New: later"],
    ["provider-model-id", "later-model"],
    ["provider-model-context-window", "4096"],
    ["provider-model-max-tokens", "2048"],
    ["provider-model-temperature", "0.8"],
  ])("an older save retains newer %s input and its focus", async (name, value) => {
    let release!: () => void;
    vi.mocked(saveModelPrefs).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true, prefs: CATALOG_ONE } as never); }));
    setModels(CATALOG_ONE as never);
    const { container } = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    const form = container.querySelector('form')!;
    await fireEvent.submit(form);
    expect(saveModelPrefs).toHaveBeenCalledTimes(1);
    const input = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`)!;
    input.focus();
    await fireEvent.input(input, { target: { value } });
    release();
    await waitFor(() => expect(!form.isConnected || container.querySelector('[data-verb-id="models.provider/save"]')?.getAttribute('aria-busy') === 'false').toBe(true));
    expect(input.isConnected, "successful older work must not remove newer input").toBe(true);
    expect(input.value).toBe(value);
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-field="provider-form-note"]')?.textContent).toBe(`Saved ${CATALOG_ONE.providers[0]!.id}. Newer changes are unsaved.`);
  });

  test("an older completion cannot close a canceled and reopened form", async () => {
    let release!: () => void;
    vi.mocked(saveModelPrefs).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ ok: true, prefs: CATALOG_ONE } as never); }));
    setModels(CATALOG_ONE as never);
    const {container} = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    await fireEvent.submit(container.querySelector('form')!);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/cancel"]')!);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    const name = field(container, 'provider-name');
    await fireEvent.input(name, {target:{value:'another-provider'}});
    name.focus();
    release();
    await Promise.resolve();
    await waitFor(() => expect(name.isConnected).toBe(true));
    expect(name.value).toBe('another-provider');
    expect(document.activeElement).toBe(name);
    expect(container.querySelector('[data-verb-id="models.provider/save"]')?.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('[data-field="provider-form-note"]')).toBeNull();
  });

  test("repeat Test activation issues one request until its result settles", async () => {
    let release!: () => void;
    vi.mocked(testModelProvider).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ok:false,failureKind:'no-answer',detail:'held answer',elapsedMs:7} as never); }));
    setModels(CATALOG_ONE as never);
    const {container} = render(ProvidersSection);
    const button = container.querySelector<HTMLButtonElement>('[data-verb-id="models.provider/test"]')!;
    button.focus();
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(testModelProvider).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);
    release();
    await waitFor(() => expect(button.getAttribute('aria-disabled')).toBe('false'));
    expect(container.querySelector('[data-field="provider-test-note"]')?.textContent).toContain('held answer');
    await fireEvent.click(button);
    expect(testModelProvider).toHaveBeenCalledTimes(2);
  });
});

describe("Provider entity names are data, including inherited object names", () => {
  test.each(["constructor", "toString"])("%s gets its own reactive Test result", async id => {
    let release!: () => void;
    vi.mocked(testModelProvider).mockImplementationOnce(() => new Promise(resolve => {release=()=>resolve({ok:false,failureKind:"no-answer",detail:"own provider reply",elapsedMs:3} as never)}));
    setModels({...CATALOG_ONE,providers:[{...CATALOG_ONE.providers[0],id}]} as never);
    const {container}=render(ProvidersSection);
    expect(container.querySelector('[data-field="provider-test-note"]'), 'no inherited object value is a provider verdict').toBeNull();
    const button=container.querySelector('[data-verb-id="models.provider/test"]')!;
    await fireEvent.click(button);
    expect(container.querySelector('[data-field="provider-test-note"]')?.textContent).toContain('asking the provider');
    release();
    await waitFor(()=>expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(container.querySelector('[data-field="provider-test-note"]')?.textContent).toContain('own provider reply');
  });
});

describe("later form ownership across structural edits and request ordering", () => {
  test.each(['add','remove'] as const)('model-row %s survives older success', async action => {
    let release!:()=>void;
    vi.mocked(saveModelPrefs).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({ok:true,prefs:CATALOG_TWO_MODELS} as never)}));
    setModels(CATALOG_TWO_MODELS as never);
    const {container}=render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    const form=container.querySelector('form')!;
    await fireEvent.submit(form);
    await fireEvent.click(action==='add'?container.querySelector('[data-verb-id="models.provider/add-model"]')!:container.querySelectorAll('[data-verb-id="models.provider/remove-model"]')[1]!);
    const input=field(container,'provider-base-url');input.focus();
    release();
    await waitFor(()=>expect(!form.isConnected||container.querySelector('[data-verb-id="models.provider/save"]')?.getAttribute('aria-busy')==='false').toBe(true));
    expect(form.isConnected).toBe(true);
    expect(container.querySelectorAll('[name="provider-model-id"]')).toHaveLength(action==='add'?3:1);
    expect(document.activeElement).toBe(input);
  });

  test('an add-name edit remains a new draft after its earlier name is saved', async()=>{
    let release!:()=>void;
    vi.mocked(saveModelPrefs).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({ok:true,prefs:CATALOG_ONE} as never)}));
    setModels(CATALOG_EMPTY as never);const {container}=render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/add"]')!);
    for(const [name,value] of [['provider-name','earlier'],['provider-base-url','http://localhost/v1'],['provider-model-id','m']])await fireEvent.input(field(container,name!),{target:{value}});
    const form=container.querySelector('form')!;await fireEvent.submit(form);
    const input=field(container,'provider-name');await fireEvent.input(input,{target:{value:'later'}});input.focus();release();
    await waitFor(()=>expect(!form.isConnected||container.querySelector('[data-verb-id="models.provider/save"]')?.getAttribute('aria-busy')==='false').toBe(true));
    expect(input.isConnected).toBe(true);expect(input.value).toBe('later');expect(input.readOnly).toBe(false);expect(document.activeElement).toBe(input);
  });

  test.each(['same','different'] as const)('older response cannot settle the reopened %s target request',async target=>{
    const releases:Array<()=>void>=[];
    vi.mocked(saveModelPrefs).mockImplementation(()=>new Promise(resolve=>{releases.push(()=>resolve({ok:true,prefs:CATALOG_ONE} as never))}));
    setModels({...CATALOG_ONE,providers:[...CATALOG_ONE.providers,{...CATALOG_ONE.providers[0],id:'second'}]} as never);const {container}=render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-provider="local"] [data-verb-id="models.provider/edit"]')!);await fireEvent.submit(container.querySelector('form')!);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/cancel"]')!);const id=target==='same'?'local':'second';
    await fireEvent.click(container.querySelector(`[data-provider="${id}"] [data-verb-id="models.provider/edit"]`)!);
    const form=container.querySelector('form')!,input=field(container,'provider-base-url');await fireEvent.input(input,{target:{value:'http://localhost/new-opening'}});await fireEvent.submit(form);input.focus();
    releases[0]!();await new Promise(resolve=>setTimeout(resolve,0));
    expect(form.isConnected).toBe(true);expect(input.value).toBe('http://localhost/new-opening');expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-verb-id="models.provider/save"]')?.getAttribute('aria-busy')).toBe('true');expect(container.querySelector('[data-field="provider-form-note"]')).toBeNull();
    releases[1]!();await waitFor(()=>expect(form.isConnected).toBe(false));
  });

  test('a saved revision invalidates its older Test result without blocking another provider',async()=>{
    let release!:()=>void;vi.mocked(testModelProvider).mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({ok:false,failureKind:'no-answer',detail:'stale provider result',elapsedMs:2} as never)}));
    setModels({...CATALOG_ONE,providers:[...CATALOG_ONE.providers,{...CATALOG_ONE.providers[0],id:'second'}]} as never);const {container}=render(ProvidersSection);
    const row=container.querySelector('[data-provider="local"]')!,button=row.querySelector('[data-verb-id="models.provider/test"]')!;await fireEvent.click(button);
    await fireEvent.click(container.querySelector('[data-provider="second"] [data-verb-id="models.provider/test"]')!);expect(testModelProvider).toHaveBeenCalledTimes(2);
    await fireEvent.click(row.querySelector('[data-verb-id="models.provider/edit"]')!);await fireEvent.submit(container.querySelector('form')!);await waitFor(()=>expect(container.querySelector('form')).toBeNull());
    await fireEvent.click(button);expect(testModelProvider).toHaveBeenCalledTimes(2);release();await waitFor(()=>expect(button.getAttribute('aria-busy')).toBe('false'));
    expect(row.textContent).not.toContain('stale provider result');await fireEvent.click(button);expect(testModelProvider).toHaveBeenCalledTimes(3);
  });
});

test.each([false,true])('refused provider save retains the current draft and retry (newer edit: %s)',async newer=>{
  let refuse!:(error:Error)=>void;vi.mocked(saveModelPrefs).mockImplementationOnce(()=>new Promise((_resolve,reject)=>{refuse=reject}));setModels(CATALOG_ONE as never);const {container}=render(ProvidersSection);await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);const form=container.querySelector('form')!,input=field(container,'provider-base-url');await fireEvent.input(input,{target:{value:'http://localhost/earlier'}});await fireEvent.submit(form);if(newer)await fireEvent.input(input,{target:{value:'http://localhost/newer'}});input.focus();refuse(Error('recorded provider refusal'));await waitFor(()=>expect(container.querySelector('[data-field="provider-form-note"]')?.textContent).toBe('recorded provider refusal'));expect(form.isConnected).toBe(true);expect(input.value).toBe(newer?'http://localhost/newer':'http://localhost/earlier');expect(document.activeElement).toBe(input);await fireEvent.submit(form);await waitFor(()=>expect(form.isConnected).toBe(false));expect(vi.mocked(saveModelPrefs).mock.calls[1]![0].providers[0]!.baseUrl).toBe(newer?'http://localhost/newer':'http://localhost/earlier');
});

describe("provider discovery keeps manual drafts authoritative", () => {
  test("one discovery adds only selected IDs and reported limits; shorthand saves expanded numbers", async () => {
    vi.mocked(discoverModelProvider).mockResolvedValueOnce({ ok: true, models: [{id:"remote/large",contextWindow:32000,maxTokens:2048},{id:"remote/bare"}] });
    setModels(CATALOG_ONE as never);
    const {container} = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/discover"]')!);
    expect(discoverModelProvider).toHaveBeenCalledWith({savedProviderId:"local",baseUrl:CATALOG_ONE.providers[0]!.baseUrl},expect.any(AbortSignal));
    const picker = await waitFor(() => { const p=container.querySelector<HTMLSelectElement>('[name="provider-discovered-model"]');expect(p).not.toBeNull();return p!; });
    expect(container.querySelectorAll('.model-row')).toHaveLength(1);
    await fireEvent.change(picker,{target:{value:"remote/large"}});
    expect(rowInput(container,0,"model-id").value).toBe("m-1");
    expect(rowInput(container,1,"model-context-window").value).toBe("32000");
    expect(rowInput(container,1,"model-max-tokens").value).toBe("2048");
    await fireEvent.input(rowInput(container,1,"model-context-window"),{target:{value:"1.5m"}});
    await fireEvent.input(rowInput(container,1,"model-max-tokens"),{target:{value:"32K"}});
    expect(container.textContent).toContain("1500000 tokens");
    expect(container.textContent).toContain("32000 tokens");
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(()=>expect(saveModelPrefs).toHaveBeenCalledWith({providers:[{id:"local",baseUrl:CATALOG_ONE.providers[0]!.baseUrl,models:[{id:"m-1"},{id:"remote/large",contextWindow:1500000,maxTokens:32000}]}]}));
  });

  test.each(["provider-base-url","provider-api-key","provider-headers"])("changing %s cancels the pending request and ignores its late answer", async name => {
    let release!: (result: {ok:true;models:{id:string}[]}) => void;
    vi.mocked(discoverModelProvider).mockImplementationOnce(() => new Promise(resolve => { release=resolve; }));
    setModels(CATALOG_ONE as never);
    const {container} = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    const discover=container.querySelector('[data-verb-id="models.provider/discover"]')!;
    await fireEvent.click(discover);await fireEvent.click(discover);
    expect(discoverModelProvider).toHaveBeenCalledTimes(1);
    const signal=vi.mocked(discoverModelProvider).mock.calls[0]![1]!;
    await fireEvent.input(container.querySelector('[name="'+name+'"]')!,{target:{value:name==="provider-headers"?"X-Org: changed":"changed"}});
    expect(signal.aborted).toBe(true);
    release({ok:true,models:[{id:"stale-result"}]});
    await Promise.resolve();
    expect(container.querySelector('[name="provider-discovered-model"]')).toBeNull();
    expect(rowInput(container,0,"model-id").value).toBe("m-1");
    expect(saveModelPrefs).not.toHaveBeenCalled();
  });

  test("close/unmount cancels discovery while an endpoint refusal leaves manual rows usable", async () => {
    vi.mocked(discoverModelProvider).mockResolvedValueOnce({ok:false,failureKind:"refused-key",detail:"wrong credential"});
    setModels(CATALOG_ONE as never);
    const {container,unmount} = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/discover"]')!);
    await waitFor(()=>expect(container.textContent).toContain("wrong credential"));
    await fireEvent.input(rowInput(container,0,"model-id"),{target:{value:"manual-after-refusal"}});
    vi.mocked(discoverModelProvider).mockImplementationOnce(()=>new Promise(()=>{}));
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/discover"]')!);
    const signal=vi.mocked(discoverModelProvider).mock.calls.at(-1)![1]!;
    await unmount();expect(signal.aborted).toBe(true);
    expect(saveModelPrefs).not.toHaveBeenCalled();
  });

  test("large catalogs remain fully reachable with bounded options and manual row identity survives deletion", async () => {
    vi.mocked(discoverModelProvider).mockResolvedValueOnce({ok:true,models:Array.from({length:1000},(_,i)=>({id:"remote-"+i}))});
    setModels(CATALOG_TWO_MODELS as never);
    const {container} = render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    const second=rowInput(container,1,"model-id");
    second.closest('.model-row')!.querySelector('details')!.open=true;
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/remove-model"]')!);
    expect(rowInput(container,0,"model-id")).toBe(second);
    expect(second.closest('.model-row')!.querySelector('details')!.open).toBe(true);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/discover"]')!);
    await waitFor(()=>expect(container.querySelector('[name="provider-discovered-model"]')).not.toBeNull());
    expect(container.querySelectorAll('[name="provider-discovered-model"] option').length).toBeLessThanOrEqual(25);
    const next = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Next models")!;
    expect(next.type).toBe("button");
    await fireEvent.click(next);
    expect(saveModelPrefs).not.toHaveBeenCalled();
    expect(second.isConnected).toBe(true);
    await fireEvent.input(container.querySelector('[name="provider-discovery-query"]')!,{target:{value:"remote-999"}});
    const pick=container.querySelector<HTMLSelectElement>('[name="provider-discovered-model"]')!;
    expect([...pick.options].map(o=>o.value)).toEqual(["","remote-999"]);
    await fireEvent.change(pick,{target:{value:"remote-999"}});
    expect(rowInput(container,1,"model-id").value).toBe("remote-999");
    expect(rowInput(container,1,"model-context-window").value).toBe("");
  });
});

describe("saved header removal is an explicit draft", () => {
  test.each(["remove","replace","undo"])("%s is shared by discovery and Save", async mode => {
    setModels(CATALOG_WITH_HEADERS as never);
    const {container}=render(ProvidersSection);
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/edit"]')!);
    const clear=container.querySelector('[data-verb-id="models.provider/clear-headers"]')!;
    await fireEvent.click(clear);
    if(mode==="undo") await fireEvent.click(clear);
    if(mode==="replace") await fireEvent.input(container.querySelector('[name="provider-headers"]')!,{target:{value:"X-Replacement: new-value"}});
    await fireEvent.click(container.querySelector('[data-verb-id="models.provider/discover"]')!);
    const input=vi.mocked(discoverModelProvider).mock.calls[0]![0];
    const expected=mode==="remove"?{}:mode==="replace"?{"X-Replacement":"new-value"}:undefined;
    expect(input.headers).toEqual(expected);
    expect(Object.hasOwn(input,"headers")).toBe(mode!=="undo");
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(()=>expect(saveModelPrefs).toHaveBeenCalledTimes(1));
    const saved=vi.mocked(saveModelPrefs).mock.calls[0]![0].providers[0]!;
    expect(saved.headers).toEqual(expected);
    expect(Object.hasOwn(saved,"headers")).toBe(mode!=="undo");
  });
});
