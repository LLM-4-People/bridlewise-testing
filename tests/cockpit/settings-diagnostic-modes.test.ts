// @vitest-environment jsdom
/**
 * THE DIAGNOSTIC MODES SECTION IN THE SETTINGS ROOM — the array door's face
 * (the round-39 filing closed: `performance.diagnosticModes.excludedModes`
 * could not be served as a writable row because the served-row grammar holds
 * scalars and objects only, and the sheet refuses array JSON by design).
 *
 * What this file holds down, each arm a real contract:
 *
 *   - the section renders the WIRE's own mode vocabulary (derived from the
 *     block read, never a client-side list) with each mode's honest state
 *     word (runs / skipped);
 *   - a toggle drafts, the Save verb enables only when the draft differs
 *     from the standing file, and saving posts the whole list through the
 *     settings feed's ONE write wrapper (never a second path);
 *   - a save's completion re-reads — the face always ends at the server's
 *     own answer;
 *   - a refusal renders the server's own sentence verbatim, in the refusal
 *     ink, while the standing face stands;
 *   - the SAVE WORDS come from the served block manifest (the zero-knowledge
 *     law): the button's label and its consequence are the server's
 *     declaration, never authored here;
 *   - a past view disables the save with the one owned reason (§D);
 *   - the room mounts the section INSIDE the performance category, above the
 *     rows it belongs beside.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

vi.mock("../../src/client.ts", () => ({
  // The room arm renders the WHOLE room, so the provider section's wrappers
  // must answer too — an empty catalog is the honest no-providers state.
  getModels: vi.fn(async () => ({
    providers: [],
    defaultProvider: null,
    defaultModel: null,
    setupRequired: false,
    setupRemedy: "",
  })),
  saveModelPrefs: vi.fn(async () => ({})),
  deleteModelProvider: vi.fn(async () => ({})),
  testModelProvider: vi.fn(async () => ({ ok: true, elapsedMs: 1 })),
  listMcpServers: vi.fn(async () => []),
  saveMcpServer: vi.fn(async () => ({})),
  deleteMcpServer: vi.fn(async () => undefined),
  testMcpServer: vi.fn(async () => ({ ok: true, elapsedMs: 1 })),
}));

vi.mock("../../src/cockpit/settings/settings-feed.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cockpit/settings/settings-feed.ts")>();
  return {
    ...actual,
    readDiagnosticModes: vi.fn(),
    saveDiagnosticModes: vi.fn(),
  };
});

import {
  readDiagnosticModes,
  saveDiagnosticModes,
  resetSettingsFeed,
  setSettingsReaders,
} from "../../src/cockpit/settings/settings-feed.ts";
import {
  resetUiSchema,
  setUiSchema,
  setUiSchemaValues,
} from "../../src/state/schema-store.ts";
import { clearCache } from "../../src/data/broker.ts";
import { plantHead, PAST_VIEW_ACT_REASON, returnToLive } from "../../src/data/asof.ts";
import { bindShellVisibility, setVisibleRoom } from "../../src/cockpit/shell/room-visibility.ts";
import DiagnosticModesSection from "../../src/cockpit/settings/DiagnosticModesSection.svelte";
import type { BlockActionDescriptor } from "../../shared/block-contract.ts";

/** The wire's vocabulary, stated once for the fixtures — the arms assert the
 * SECTION renders exactly this, in the wire's order. */
const MODES: readonly string[] = ["cpu", "memory", "io", "event-loop", "process", "cgroup"];

const SET_DESCRIPTOR: BlockActionDescriptor = {
  name: "set",
  title: "Save",
  consequence:
    "Saves which modes run on the next diagnostic run. Enabled modes are included; disabled modes are excluded.",
};

/** A served schema carrying the diagnostic-modes block's manifest — the
 * zero-knowledge surface the section's Save words must come from. */
function schemaWithBlockActions(blockActions: Record<string, readonly BlockActionDescriptor[]>): unknown {
  return {
    version: "bridlewise-ui-schema/v2",
    modules: [],
    menus: [],
    panels: [],
    widgets: [],
    settings: [],
    actions: [],
    signals: [],
    exposureModules: [],
    blockActions,
  } as never;
}

beforeEach(() => {
  vi.mocked(readDiagnosticModes).mockReset();
  vi.mocked(saveDiagnosticModes).mockReset();
  vi.mocked(readDiagnosticModes).mockImplementation(async () => ({
    modes: MODES,
    excluded: [],
  }));
  vi.mocked(saveDiagnosticModes).mockImplementation(async () => undefined);
  resetSettingsFeed();
  resetUiSchema();
  setUiSchema(schemaWithBlockActions({
    "settings.diagnosticModes": [SET_DESCRIPTOR],
  }) as never);
  setUiSchemaValues({ signals: [], customizations: [] } as never);
});

afterEach(() => {
  cleanup();
  returnToLive();
  resetSettingsFeed();
  resetUiSchema();
});

/** Render the section with the settings room visible (the kept-alive law:
 * the section reads on reveal, never for nobody). */
async function renderSection(): Promise<HTMLElement> {
  const { container } = render(DiagnosticModesSection);
  setVisibleRoom("settings");
  await waitFor(() => {
    expect(container.querySelector('[data-diagnostic-mode="cpu"]')).not.toBeNull();
  });
  return container;
}

function included(container: HTMLElement, mode: string): boolean {
  const control = container.querySelector<HTMLElement>(`[data-diagnostic-mode="${mode}"] [role="switch"]`)!;
  expect(control.textContent?.trim(), "switch position carries state without repeated prose").toBe("");
  expect(control.getAttribute("aria-label")).toBe(`Run ${mode} on the next diagnostic run`);
  return control.getAttribute("aria-checked") === "true";
}

function saveVerb(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-verb-id="settings.diagnosticModes/set"]')!;
}

describe("the diagnostic modes section — the array leaf's own face", () => {
  test("the list renders the wire's vocabulary with each mode's honest checked state", async () => {
    const container = await renderSection();
    for (const mode of MODES) {
      expect(
        container.querySelector(`[data-diagnostic-mode="${mode}"]`),
        `the declared mode ${mode} must render as its own row`,
      ).not.toBeNull();
    }
    expect(container.querySelectorAll("[data-diagnostic-mode]")).toHaveLength(MODES.length);
    expect(included(container, "cpu")).toBe(true);
    expect(container.querySelector('[data-diagnostic-mode="cpu"] [role="switch"]')?.getAttribute("aria-checked")).toBe("true");
    // The read's own excluded list drives the checked state, not a guess.
    expect(included(container, "memory")).toBe(true);
  });

  test("an excluded mode renders as skipped — the wire's own answer", async () => {
    vi.mocked(readDiagnosticModes).mockImplementation(async () => ({
      modes: MODES,
      excluded: ["cpu", "io"],
    }));
    const container = await renderSection();
    expect(included(container, "cpu")).toBe(false);
    expect(container.querySelector('[data-diagnostic-mode="cpu"] [role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(included(container, "io")).toBe(false);
    expect(included(container, "memory")).toBe(true);
  });

  test("a toggle drafts; Save enables only when the draft differs, and posts the WHOLE list through the feed's one wrapper", async () => {
    const container = await renderSection();
    const save = saveVerb(container);
    expect(save.getAttribute("aria-disabled"), "the standing list equals the draft — nothing to save").toBe("true");
    fireEvent.click(save);
    expect(saveDiagnosticModes).not.toHaveBeenCalled();

    const cpu = container.querySelector<HTMLButtonElement>('[data-diagnostic-mode="cpu"] [role="switch"]')!;
    fireEvent.click(cpu);
    await waitFor(() => expect(save.getAttribute("aria-disabled")).toBe("false"));
    expect(included(container, "cpu")).toBe(false);

    fireEvent.click(save);
    await waitFor(() => {
      expect(saveDiagnosticModes).toHaveBeenCalledTimes(1);
    });
    expect(vi.mocked(saveDiagnosticModes).mock.calls[0]![0]).toEqual(["cpu"]);
  });

  test("a save's completion re-reads — the face ends at the server's own answer", async () => {
    let excluded: readonly string[] = [];
    vi.mocked(readDiagnosticModes).mockImplementation(async () => ({ modes: MODES, excluded }));
    vi.mocked(saveDiagnosticModes).mockImplementation(async (next) => {
      excluded = next;
    });
    const container = await renderSection();
    const cpu = container.querySelector<HTMLButtonElement>('[data-diagnostic-mode="cpu"] [role="switch"]')!;
    fireEvent.click(cpu);
    fireEvent.click(saveVerb(container));
    await waitFor(() => {
      expect(
        container.querySelector('[data-field="diagnostic-modes-note"]')?.textContent,
      ).toContain("Saved. The list shows the confirmed configuration.");
    });
    await waitFor(() => {
      expect(vi.mocked(readDiagnosticModes).mock.calls.length).toBe(2);
    });
  });

  test("a refusal renders the server's own sentence in the refusal ink, and the standing face stands", async () => {
    const container = await renderSection();
    vi.mocked(saveDiagnosticModes).mockImplementation(async () => {
      throw new Error('"kernel-panic" is not one of the declared diagnostic modes — cpu, memory, io, event-loop, process, cgroup');
    });
    const cpu = container.querySelector<HTMLButtonElement>('[data-diagnostic-mode="cpu"] [role="switch"]')!;
    fireEvent.click(cpu);
    fireEvent.click(saveVerb(container));
    const note = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-field="diagnostic-modes-note"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(note.textContent).toContain('"kernel-panic" is not one of the declared diagnostic modes');
    expect(note.classList.contains("not-saved")).toBe(true);
    // The standing list stands: the row still shows the file's own answer.
    expect(included(container, "memory")).toBe(true);
  });

  test("the SAVE WORDS come from the served block manifest, never authored", async () => {
    const container = await renderSection();
    const save = saveVerb(container);
    expect(save.textContent).toBe(SET_DESCRIPTOR.title);
    expect(save.title).toBe(SET_DESCRIPTOR.consequence);
    // And with NO served declaration, the honest fallback words stand —
    // never an invented manifest.
    resetUiSchema();
    setUiSchema(schemaWithBlockActions({}) as never);
    await waitFor(() => {
      expect(saveVerb(container).title).not.toBe(SET_DESCRIPTOR.consequence);
    });
  });

  test("a past view disables the save with the one owned reason (§D)", async () => {
    const container = await renderSection();
    const cpu = container.querySelector<HTMLButtonElement>('[data-diagnostic-mode="cpu"] [role="switch"]')!;
    fireEvent.click(cpu);
    expect(saveVerb(container).disabled).toBe(false);
    plantHead(1_700_000_000_000);
    await waitFor(() => {
      expect(saveVerb(container).disabled, "a past view is read-only — the config write must refuse before the wire").toBe(true);
    });
    expect(saveVerb(container).title).toBe(PAST_VIEW_ACT_REASON);
  });

  test("the room mounts the section INSIDE the performance category", async () => {
    // No bindShellVisibility here, on purpose — the MCP room arm's shape: with
    // no shell published, a mounted surface counts as visible, which is what
    // lets the section's kept-alive read fire in an isolated room render.
    try {
      const schema = {
        version: "bridlewise-ui-schema/v2",
        modules: [],
        menus: [],
        panels: [],
        widgets: [],
        settings: [{
          id: "performance.diagnosticModeTimeoutMs",
          label: "How long one diagnostic mode may run",
          description: "Each mode of the diagnostic command is reported as timed out once its collection runs longer than this many milliseconds.",
          type: "number",
          default: 30000,
          min: 1,
          max: 3_600_000,
          unit: "milliseconds",
          customizationId: "performance.diagnosticModeTimeoutMs",
          module: "performance",
          effect: "next-run",
          order: 0,
        }],
        actions: [],
        signals: [],
        exposureModules: [{
          id: "performance",
          title: "What the harness measures about itself",
          purpose: "The dials and switches of the harness's own observability.",
        }],
        blockActions: {
          "settings.diagnosticModes": [SET_DESCRIPTOR],
        },
      } as never;
      clearCache();
      resetSettingsFeed();
      resetUiSchema();
      setUiSchema(schema);
      setUiSchemaValues({
        signals: [],
        customizations: [{ id: "performance.diagnosticModeTimeoutMs", value: 30000 }],
      } as never);
      setSettingsReaders({
        schema: async () => setUiSchema(schema),
        values: async () =>
          setUiSchemaValues({
            signals: [],
            customizations: [{ id: "performance.diagnosticModeTimeoutMs", value: 30000 }],
          } as never),
      });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get: () => 0,
      });
      // jsdom has no ResizeObserver; the room's river binds one.
      vi.stubGlobal("ResizeObserver", class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      });
      const SettingsRoom = (await import("../../src/cockpit/rooms/SettingsRoom.svelte")).default;
      const { container } = render(SettingsRoom, { shell: shellStub() });
      await waitFor(() => {
        expect(
          container.querySelector('[data-category="performance"] [data-field="diagnostic-modes"]'),
          "the array section must render INSIDE the performance category — beside the rows it serves",
        ).not.toBeNull();
      });
      // The read settles: the mode rows appear with the wire's vocabulary.
      await waitFor(() => {
        expect(
          container.querySelector('[data-category="performance"] [data-diagnostic-mode="event-loop"]'),
        ).not.toBeNull();
      });
      expect(included(container, "event-loop")).toBe(true);
    } finally {
      cleanup();
      vi.unstubAllGlobals();
      clearCache();
      resetSettingsFeed();
      resetUiSchema();
    }
  });
});

/** The shell stub the room needs (the settings-mcp-servers room arm's shape). */
function shellStub(): unknown {
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
    openScope: () => {},
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
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

test('a newer diagnostic draft removes the earlier confirmed-list success', async () => {
  const container = await renderSection();
  await fireEvent.click(container.querySelector('[data-diagnostic-mode="cpu"] [role="switch"]')!);
  vi.mocked(readDiagnosticModes).mockResolvedValueOnce({modes:MODES,excluded:['cpu']});
  await fireEvent.click(saveVerb(container));
  await waitFor(() => expect(container.querySelector('[data-field="diagnostic-modes-note"]')?.textContent).toContain('Saved'));
  await fireEvent.click(container.querySelector('[data-diagnostic-mode="memory"] [role="switch"]')!);
  expect(container.textContent).toContain('Unsaved changes');
  expect(container.querySelector('[data-field="diagnostic-modes-note"]')).toBeNull();
  expect(saveDiagnosticModes).toHaveBeenCalledTimes(1);
});
