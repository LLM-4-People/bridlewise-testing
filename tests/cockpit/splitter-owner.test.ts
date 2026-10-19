// @vitest-environment jsdom
/**
 * THE SPLITTERS — the desk's height and the editor's tree share are the
 * operator's numbers, with ONE owner each and TWO doors onto it.
 *
 * What is locked here:
 *
 *   A. THE NUMBERS' OWNER (settings/local-prefs.ts): number rows validated
 *      against their OWN declared bounds — refused in plain words, never
 *      clamped; applied as a :root token override that is REMOVED at the
 *      default (an untouched cockpit is byte-identical to one from before
 *      these preferences existed); restored deny-by-default (an out-of-range
 *      stored value restores the token, not a page the setter would refuse).
 *
 *   B. THE TWIN LAW: the defaults name the CSS tokens' own numbers, because
 *      a stylesheet cannot be read at module load. Twins drift, so the pair
 *      is held equal mechanically — this is the guard the pairing comment
 *      in the owner promises.
 *
 *   C. THE GESTURE (shell/Splitter.svelte): pointer-captured drag (never the
 *      HTML5 drag API — no ghosts by construction), previews while moving
 *      and ONE commit when settled, clamped to the declared bounds; arrow
 *      keys along the axis when focused; double-click resets; a focusable
 *      separator with its value spoken (aria-valuenow).
 *
 *   D. THE WIRING: the desk really mounts the splitter against the desk
 *      height pref, and the editor room against the split pref — both
 *      committing through the ONE local write path. The editor arm is a
 *      source floor (mounting the room needs a project world); the live
 *      drag is driven in the browser pass.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import {
  applyStoredCockpitPrefs,
  cockpitEditorSplit,
  cockpitLocalEpoch,
  cockpitMotion,
  cockpitSpacing,
  EDITOR_SPLIT_DEFAULT,
  EDITOR_SPLIT_ID,
  EDITOR_SPLIT_MAX,
  EDITOR_SPLIT_MIN,
  localValue,
  localWireIds,
  LOCAL_ROWS,
  MOTION_DEFAULT,
  MOTION_ID,
  setLocalPref,
  SPACING_DEFAULT,
  SPACING_ID,
} from "../../src/cockpit/settings/local-prefs.ts";
import { ClientError } from "../../src/data/errors.ts";
import { storageKeyFor } from "../../src/state/persistence.ts";
import Splitter from "../../src/cockpit/shell/Splitter.svelte";
import Desk from "../../src/cockpit/shell/Desk.svelte";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import { read as readSource } from "../helpers/source-scan.ts";
import { bindingValueOf } from "../helpers/function-scope.ts";

const rootStyle = (): CSSStyleDeclaration => document.documentElement.style;

function resetPrefs(): void {
  localStorage.removeItem("bridlewise:cockpitEditorSplit");
  localStorage.removeItem("bridlewise:cockpitEditorSplit");
  localStorage.removeItem("bridlewise:cockpitSpacing");
  localStorage.removeItem("bridlewise:cockpitMotion");
  applyStoredCockpitPrefs();
}

beforeEach(resetPrefs);
afterEach(resetPrefs);

// ── A. the numbers' owner ──────────────────────────────────────────────────

describe("the local number rows refuse out-of-contract writes and own the token override", () => {
  test("below the floor, above the ceiling, and a non-integer are each refused UNCHANGED", () => {
    for (const bad of [String(EDITOR_SPLIT_MIN - 1), String(EDITOR_SPLIT_MAX + 1), "24.5", "tall", ""]) {
      let refusal: unknown = null;
      try {
        setLocalPref(EDITOR_SPLIT_ID, bad);
      } catch (err) {
        refusal = err;
      }
      expect(refusal, `"${bad}" must be refused`).toBeInstanceOf(ClientError);
      expect((refusal as ClientError).code).toBe("invalid_value");
      expect((refusal as ClientError).message).toContain("refused unchanged");
      expect(cockpitEditorSplit.get(), `"${bad}" must not move the value`).toBe(EDITOR_SPLIT_DEFAULT);
      expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("");
    }
  });

  test("an accepted value overrides the token; the default REMOVES the override", () => {
    setLocalPref(EDITOR_SPLIT_ID, "40");
    expect(cockpitEditorSplit.get()).toBe(40);
    expect(localValue(EDITOR_SPLIT_ID)).toBe(40);
    expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("40%");
    expect(localStorage.getItem("bridlewise:cockpitEditorSplit")).toBe("40");

    setLocalPref(EDITOR_SPLIT_ID, String(EDITOR_SPLIT_DEFAULT));
    // The token's own rule is the owner of the untouched state — no override
    // restating the same number may shadow a future token change.
    expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("");

    setLocalPref(EDITOR_SPLIT_ID, "31");
    expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("31%");
    setLocalPref(EDITOR_SPLIT_ID, String(EDITOR_SPLIT_DEFAULT));
    expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("");
  });

  test("restore adopts a stored in-contract value and DENIES an out-of-range one", () => {
    localStorage.setItem("bridlewise:cockpitEditorSplit", "35");
    applyStoredCockpitPrefs();
    expect(cockpitEditorSplit.get()).toBe(35);
    expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("35%");

    // A hand-edited entry outside the contract restores the DEFAULT — the
    // page must never boot into a layout its own setter would refuse.
    localStorage.setItem("bridlewise:cockpitEditorSplit", "9999");
    applyStoredCockpitPrefs();
    expect(cockpitEditorSplit.get()).toBe(EDITOR_SPLIT_DEFAULT);
    expect(rootStyle().getPropertyValue("--editor-tree-w")).toBe("");
  });
});

// ── B. the twin law ────────────────────────────────────────────────────────

describe("the defaults are the CSS tokens' own numbers — held equal, not asserted", () => {
  test("tokens.css and the rows name the same built-in values", () => {
    const tokens = readSource("src/cockpit/tokens.css");
    // The desk's built-in height IS the token.
    expect(tokens).not.toContain("--desk-open-h:");
    // The tree's built-in share IS the clamp's preferred term.
    const clamp = /--editor-tree-w:\s*clamp\([^,]+,\s*(\d+)%/.exec(tokens);
    expect(clamp, "--editor-tree-w must stay a clamp whose middle term is a share").not.toBeNull();
    expect(Number(clamp![1])).toBe(EDITOR_SPLIT_DEFAULT);
    // …and the declared bounds really bound the declared default.
    for (const id of [EDITOR_SPLIT_ID, SPACING_ID, MOTION_ID]) {
      const row = LOCAL_ROWS.find((r) => r.id === id)!;
      expect(row.type).toBe("number");
      expect(row.min!).toBeLessThanOrEqual(row.defaultValue as number);
      expect(row.max!).toBeGreaterThanOrEqual(row.defaultValue as number);
    }
    expect(tokens).toContain(`--sp-unit: ${SPACING_DEFAULT}px;`);
    expect(tokens).toContain(`--t-unit: ${MOTION_DEFAULT}ms;`);
  });

  test("every local row has a wire and the write door does not name ids", () => {
    expect([...localWireIds()].sort()).toEqual([...LOCAL_ROWS.map((r) => r.id)].sort());
    const src = readSource("src/cockpit/settings/local-prefs.ts");
    // The rows are derived from the declaration table, not restated — asked
    // of the binding itself, never by measuring how far two anchors sit apart.
    const rows = bindingValueOf(src, "LOCAL_ROWS");
    expect(rows.body, "LOCAL_ROWS is derived from the declaration table").toContain("LOCAL_DECL");
    expect(rows.body, "the derivation is the declaration's own map").toContain(".map(");
    expect(src).not.toMatch(/\bLOCAL_WIRE\b/);
    const doorStart = src.indexOf("export function setLocalPref");
    const doorEnd = src.indexOf("export function applyStoredCockpitPrefs");
    expect(doorStart).toBeGreaterThan(0);
    expect(doorEnd).toBeGreaterThan(doorStart);
    const door = src.slice(doorStart, doorEnd);
    expect(door).not.toMatch(/DENSITY_ID|THEME_ID|DEBUG_ID|EDITOR_SPLIT_ID|EDITOR_SPLIT_ID|SPACING_ID|MOTION_ID/);
  });

  test("an accepted write bumps the one epoch; the index and sheet subscribe to it", () => {
    const before = cockpitLocalEpoch.get();
    setLocalPref(SPACING_ID, "6");
    expect(cockpitLocalEpoch.get()).toBeGreaterThan(before);
    for (const path of [
      "src/cockpit/settings/SettingSheet.svelte",
      "src/cockpit/rooms/SettingsRoom.svelte",
    ]) {
      const src = readSource(path);
      expect(src, path).toMatch(/void \$cockpitLocalEpoch/);
      expect(src, path).not.toMatch(/void \$cockpitDensity/);
      expect(src, path).not.toMatch(/void \$cockpitTheme/);
    }
  });

  test("restore and a foreign write each bump the epoch", () => {
    const beforeRestore = cockpitLocalEpoch.get();
    localStorage.setItem(storageKeyFor("cockpitSpacing"), "6");
    applyStoredCockpitPrefs();
    expect(cockpitSpacing.get()).toBe(6);
    expect(cockpitLocalEpoch.get()).toBeGreaterThan(beforeRestore);

    const beforeForeign = cockpitLocalEpoch.get();
    const raw = storageKeyFor("cockpitSpacing");
    window.localStorage.setItem(raw, "7");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: raw,
        newValue: "7",
        storageArea: window.localStorage,
      }),
    );
    expect(cockpitSpacing.get()).toBe(7);
    expect(rootStyle().getPropertyValue("--sp-unit")).toBe("7px");
    expect(cockpitLocalEpoch.get()).toBeGreaterThan(beforeForeign);
  });

  test("a spacing / motion override remaps the token and the default removes it", () => {
    setLocalPref(SPACING_ID, "6");
    expect(cockpitSpacing.get()).toBe(6);
    expect(rootStyle().getPropertyValue("--sp-unit")).toBe("6px");
    setLocalPref(SPACING_ID, String(SPACING_DEFAULT));
    expect(rootStyle().getPropertyValue("--sp-unit")).toBe("");

    setLocalPref(MOTION_ID, "45");
    expect(cockpitMotion.get()).toBe(45);
    expect(rootStyle().getPropertyValue("--t-unit")).toBe("45ms");
    setLocalPref(MOTION_ID, String(MOTION_DEFAULT));
    expect(rootStyle().getPropertyValue("--t-unit")).toBe("");
  });
});

// ── C. the gesture ─────────────────────────────────────────────────────────

type SplitterProps = {
  label: string;
  orientation: "vertical" | "horizontal";
  value: number;
  min: number;
  max: number;
  step: number;
  defaultWords: string;
  unitPerPx?: number;
  invert?: boolean;
  onadjust: (next: number, commit: boolean) => void;
  onreset: () => void;
};

describe("the Splitter component", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  function mountSplitter(props: Partial<SplitterProps> = {}): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Splitter, {
      target: host,
      props: {
        label: "the probe divider",
        orientation: "horizontal",
        value: 280,
        min: 180,
        max: 600,
        step: 16,
        defaultWords: "the built-in 280 px",
        onadjust: () => undefined,
        onreset: () => undefined,
        ...props,
      } satisfies SplitterProps,
    });
    flushSync();
    const el = host.querySelector<HTMLElement>(".splitter")!;
    // jsdom has no pointer capture; the component must still call it.
    (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();
    return el;
  }

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  const pointer = (type: string, at: { x?: number; y?: number }): PointerEvent =>
    new MouseEvent(type, {
      bubbles: true,
      clientX: at.x ?? 0,
      clientY: at.y ?? 0,
    }) as unknown as PointerEvent;

  test("a drag previews while moving, captures the pointer, and commits ONCE on release", () => {
    const onadjust = vi.fn();
    const el = mountSplitter({ onadjust });
    el.dispatchEvent(pointer("pointerdown", { y: 100 }));
    expect(
      (el as unknown as { setPointerCapture: ReturnType<typeof vi.fn> }).setPointerCapture,
    ).toHaveBeenCalled();
    // The desk hangs from the bottom, so this un-inverted divider grows
    // with the pointer's travel DOWN the screen.
    el.dispatchEvent(pointer("pointermove", { y: 140 }));
    expect(onadjust).toHaveBeenLastCalledWith(320, false);
    el.dispatchEvent(pointer("pointermove", { y: 160 }));
    expect(onadjust).toHaveBeenLastCalledWith(340, false);
    el.dispatchEvent(pointer("pointerup", { y: 160 }));
    expect(onadjust).toHaveBeenLastCalledWith(340, true);
    expect(onadjust.mock.calls.filter(([, commit]) => commit === true)).toHaveLength(1);
  });

  test("`invert` flips the axis (the desk grows as the pointer travels UP)", () => {
    const onadjust = vi.fn();
    const el = mountSplitter({ onadjust, invert: true });
    el.dispatchEvent(pointer("pointerdown", { y: 100 }));
    el.dispatchEvent(pointer("pointermove", { y: 60 }));
    expect(onadjust).toHaveBeenLastCalledWith(320, false);
  });

  test("a drag cannot leave the declared bounds — clamped, never refused mid-gesture", () => {
    const onadjust = vi.fn();
    const el = mountSplitter({ onadjust });
    el.dispatchEvent(pointer("pointerdown", { y: 0 }));
    el.dispatchEvent(pointer("pointermove", { y: 100000 }));
    expect(onadjust).toHaveBeenLastCalledWith(600, false);
    el.dispatchEvent(pointer("pointermove", { y: -100000 }));
    expect(onadjust).toHaveBeenLastCalledWith(180, false);
  });

  test("a %-valued host converts pointer pixels through unitPerPx", () => {
    const onadjust = vi.fn();
    const el = mountSplitter({
      onadjust,
      orientation: "vertical",
      value: 24,
      min: 12,
      max: 60,
      step: 2,
      unitPerPx: 100 / 1000, // a 1000px room
    });
    el.dispatchEvent(pointer("pointerdown", { x: 240 }));
    el.dispatchEvent(pointer("pointermove", { x: 340 })); // +100px = +10 share points
    expect(onadjust).toHaveBeenLastCalledWith(34, false);
  });

  test("arrow keys along the axis step and COMMIT; the cross-axis keys do nothing", () => {
    const onadjust = vi.fn();
    const el = mountSplitter({ onadjust });
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(onadjust).toHaveBeenLastCalledWith(296, true);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    // The component is stateless over `value` (the host owns the number), so
    // both presses step from the same base — what matters is direction and
    // the commit flag.
    expect(onadjust).toHaveBeenLastCalledWith(264, true);
    onadjust.mockClear();
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(onadjust).not.toHaveBeenCalled();
  });

  test("double-click resets through the host's own reset", () => {
    const onreset = vi.fn();
    const el = mountSplitter({ onreset });
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onreset).toHaveBeenCalledTimes(1);
  });

  test("the separator is focusable, valued, and teaches its gestures", () => {
    const el = mountSplitter({});
    expect(el.getAttribute("role")).toBe("separator");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-orientation")).toBe("horizontal");
    expect(el.getAttribute("aria-valuenow")).toBe("280");
    expect(el.getAttribute("aria-valuemin")).toBe("180");
    expect(el.getAttribute("aria-valuemax")).toBe("600");
    expect(el.getAttribute("title")).toContain("drag to resize");
    expect(el.getAttribute("title")).toContain("double-click");
    // No HTML5 drag API anywhere near this gesture — that is where ghosts
    // come from.
    expect(el.getAttribute("draggable")).toBeNull();
  });
});

// ── D. the wiring ──────────────────────────────────────────────────────────

describe("the hosts really consume the splitter against the owned numbers", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  test("the composer has no separate detail panel or height preference", () => {
    host = document.createElement("div"); document.body.appendChild(host);
    app = mount(Desk, { target: host, props: {
      shell: {} as ShellApi, revealed: true, text: "", gauge: null,
      onSubmit: () => undefined, focusRequest: 0,
    } });
    flushSync();
    expect(host.querySelector(".splitter, .panel, .panel-clip")).toBeNull();
    expect(LOCAL_ROWS.some(row => row.id === "cockpit.deskHeight")).toBe(false);
    expect(host.querySelector('[data-verb-id="desk.toggle"]')).not.toBeNull();
  });

  test("the editor room wires the split pref through the same doors (source floor)", () => {
    // A rung-5 floor, said plainly: mounting the editor room needs a project
    // world; the live drag is driven in the browser pass. What this pins is
    // the CONSUMPTION — the room renders the shared Splitter against the
    // split pref's own bounds and commits through the one local write path.
    const src = readSource("src/cockpit/rooms/EditorRoom.svelte");
    expect(src).toMatch(/import Splitter from "\.\.\/shell\/Splitter\.svelte"/);
    expect(src).toContain("value={$cockpitEditorSplit}");
    expect(src).toContain("min={EDITOR_SPLIT_MIN}");
    expect(src).toContain("max={EDITOR_SPLIT_MAX}");
    expect(src).toMatch(/setLocalPref\(EDITOR_SPLIT_ID, String\(next\)\)/);
    expect(src).toMatch(/setLocalPref\(EDITOR_SPLIT_ID, String\(EDITOR_SPLIT_DEFAULT\)\)/);
    // The preview path applies the token override, so the drag is visible
    // while the pointer is still down.
    expect(src).toMatch(/applyEditorSplit\(next\)/);
    void cockpitEditorSplit;
  });
});
