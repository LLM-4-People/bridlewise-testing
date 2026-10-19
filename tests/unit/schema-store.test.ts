// @vitest-environment node
import { describe, test, expect, beforeEach, vi } from "vitest";
import { getUiSchemaValues } from "../../src/client.ts";
import {
  uiSchema,
  uiSchemaValues,
  uiSchemaValuesRead,
  menus,
  allPanels,
  allWidgets,
  panelsForSlot,
  widgetsForSlot,
  signalValueMap,
  getSignalValue,
  setUiSchema,
  setUiSchemaValues,
  resetUiSchema,
  beginSchemaValuesRead,
  isCurrentSchemaValuesRead,
} from "../../src/state/schema-store";
import type { UiSchema, UiSchemaValues } from "../../shared/ui-schema";

/**
 * Schema-store tests. Verifies the nanostore holds the schema, derived
 * slot-grouped stores filter+sort correctly, and signal values are looked
 * up by id.
 */

const SAMPLE_SCHEMA: UiSchema = {
  version: "bridlewise-ui-schema/v1",
  modules: [],
  menus: [
    { id: "b", label: "B", order: 2, route: "chat", group: "converse" },
    { id: "a", label: "A", order: 1, route: "chat", group: "converse" },
  ],
  panels: [
    { id: "p2", slot: "right-panel", component: "c2", order: 2 },
    { id: "p1", slot: "right-panel", component: "c1", order: 1 },
    { id: "p0", slot: "main", component: "c0", order: 0 },
  ],
  widgets: [
    { id: "w2", slot: "header-info", component: "x", order: 2 },
    { id: "w1", slot: "header-info", signalId: "sig.1", order: 1 },
    { id: "w0", slot: "chat-bar", signalId: "sig.0", order: 0 },
  ],
  settings: [],
  actions: [],
  signals: [],
};

const SAMPLE_VALUES: UiSchemaValues = {
  signals: [
    { id: "sig.0", value: 42 },
    { id: "sig.1", value: "active" },
    { id: "sig.2", value: true },
  ],
  customizations: [],
};

beforeEach(() => {
  resetUiSchema();
});

describe("schema store — set + read", () => {
  test("the real client captures the read revision before transport can complete", async () => {
    const initial = { ...SAMPLE_VALUES, customizations: [{ id: "setting", value: 4 }] };
    setUiSchemaValues(initial);
    let release!: (response: Response) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; started(); })));
    try {
      const read = getUiSchemaValues();
      await entered;
      setUiSchemaValues({ ...initial, customizations: [{ id: "setting", value: 8 }] }, beginSchemaValuesRead());
      release(new Response(JSON.stringify(initial), { headers: { "Content-Type": "application/json" } }));
      await read;
      expect(uiSchemaValues.get()!.customizations).toEqual([{ id: "setting", value: 8 }]);
    } finally { vi.unstubAllGlobals(); }
  });
  test("a post-save read reaches all consumers and an older snapshot cannot undo it", () => {
    const initial = { ...SAMPLE_VALUES, customizations: [{ id: "setting", value: 4 }] };
    setUiSchemaValues(initial);
    const oldRead = beginSchemaValuesRead();
    const readback = beginSchemaValuesRead();
    setUiSchemaValues({ ...initial, signals: [{ id: "updated-signal", value: 9 }], customizations: [{ id: "setting", value: "hidden", masked: true }] }, readback);
    expect(uiSchemaValues.get()!.customizations).toEqual([{ id: "setting", value: "hidden", masked: true }]);
    setUiSchemaValues(initial, oldRead);
    expect(uiSchemaValues.get()!.customizations).toEqual([{ id: "setting", value: "hidden", masked: true }]);
    expect(getSignalValue("updated-signal")).toBe(9);
    const freshRead = beginSchemaValuesRead();
    setUiSchemaValues({ ...initial, customizations: [{ id: "setting", value: 12 }] }, freshRead);
    expect(uiSchemaValues.get()!.customizations).toEqual([{ id: "setting", value: 12 }]);
  });

  test("a delayed older read cannot replace a more recent completed snapshot", () => {
    const oldRead = beginSchemaValuesRead(), freshRead = beginSchemaValuesRead();
    setUiSchemaValues(SAMPLE_VALUES, freshRead);
    setUiSchemaValues({ signals: [], customizations: [] }, oldRead);
    expect(uiSchemaValues.get()).toBe(SAMPLE_VALUES);
    expect(uiSchemaValuesRead.get()).toEqual(freshRead);
  });

  test("old-user read and save completions cannot write into a reset scope", () => {
    setUiSchemaValues(SAMPLE_VALUES);
    const oldRequest = beginSchemaValuesRead();
    resetUiSchema();
    expect(uiSchemaValuesRead.get()).toBeNull();
    const nextUser = { signals: [], customizations: [{ id: "setting", value: 99 }] };
    setUiSchemaValues(nextUser);
    expect(isCurrentSchemaValuesRead(oldRequest)).toBe(false);
    setUiSchemaValues(SAMPLE_VALUES, oldRequest);
    expect(uiSchemaValues.get()).toBe(nextUser);
    expect(uiSchemaValuesRead.get()?.scope).not.toBe(oldRequest.scope);
  });
  test("published read identity observers see that read's canonical values", () => {
    const observed: unknown[] = [];
    const release = uiSchemaValuesRead.listen(read => observed.push({ read, values: uiSchemaValues.get() }));
    const read = beginSchemaValuesRead();
    try {
      setUiSchemaValues(SAMPLE_VALUES, read);
      expect(observed).toEqual([{ read, values: SAMPLE_VALUES }]);
    } finally { release(); }
  });
  test("uiSchema is null by default", () => {
    expect(uiSchema.get()).toBeNull();
  });

  test("setUiSchema stores the schema", () => {
    setUiSchema(SAMPLE_SCHEMA);
    expect(uiSchema.get()).toBe(SAMPLE_SCHEMA);
  });

  test("setUiSchemaValues stores the values", () => {
    setUiSchemaValues(SAMPLE_VALUES);
    expect(uiSchemaValues.get()).toBe(SAMPLE_VALUES);
  });

  test("resetUiSchema clears both", () => {
    setUiSchema(SAMPLE_SCHEMA);
    setUiSchemaValues(SAMPLE_VALUES);
    resetUiSchema();
    expect(uiSchema.get()).toBeNull();
    expect(uiSchemaValues.get()).toBeNull();
  });
});

describe("schema store — derived menus", () => {
  test("menus are sorted by order", () => {
    setUiSchema(SAMPLE_SCHEMA);
    const list = menus.get();
    expect(list[0]?.id).toBe("a");
    expect(list[1]?.id).toBe("b");
  });

  test("menus are empty when no schema", () => {
    expect(menus.get()).toEqual([]);
  });
});

describe("schema store — derived panelsForSlot", () => {
  test("filters by slot and sorts by order", () => {
    setUiSchema(SAMPLE_SCHEMA);
    const rightPanels = panelsForSlot("right-panel");
    expect(rightPanels.length).toBe(2);
    expect(rightPanels[0]?.id).toBe("p1");
    expect(rightPanels[1]?.id).toBe("p2");
  });

  test("main slot has one panel", () => {
    setUiSchema(SAMPLE_SCHEMA);
    expect(panelsForSlot("main").length).toBe(1);
  });

  test("empty slot returns empty array", () => {
    setUiSchema(SAMPLE_SCHEMA);
    expect(panelsForSlot("modal")).toEqual([]);
  });
});

describe("schema store — derived allPanels / allWidgets", () => {
  test("allPanels is sorted by order", () => {
    setUiSchema(SAMPLE_SCHEMA);
    const panels = allPanels.get();
    expect(panels.length).toBe(3);
    // p0 (order 0), p1 (order 1), p2 (order 2)
    expect(panels[0]?.id).toBe("p0");
    expect(panels[1]?.id).toBe("p1");
    expect(panels[2]?.id).toBe("p2");
  });

  test("allWidgets is sorted by order", () => {
    setUiSchema(SAMPLE_SCHEMA);
    const widgets = allWidgets.get();
    expect(widgets.length).toBe(3);
    expect(widgets[0]?.id).toBe("w0");
    expect(widgets[1]?.id).toBe("w1");
    expect(widgets[2]?.id).toBe("w2");
  });

  test("empty when no schema", () => {
    expect(allPanels.get()).toEqual([]);
    expect(allWidgets.get()).toEqual([]);
  });
});

describe("schema store — derived widgetsForSlot", () => {
  test("filters by slot and sorts by order", () => {
    setUiSchema(SAMPLE_SCHEMA);
    const header = widgetsForSlot("header-info");
    expect(header.length).toBe(2);
    expect(header[0]?.id).toBe("w1");
    expect(header[1]?.id).toBe("w2");
  });

  test("chat-bar slot has signal-bound widget", () => {
    setUiSchema(SAMPLE_SCHEMA);
    const bar = widgetsForSlot("chat-bar");
    expect(bar.length).toBe(1);
    expect(bar[0]?.signalId).toBe("sig.0");
  });
});

describe("schema store — signal values", () => {
  test("signalValueMap builds a lookup by id", () => {
    setUiSchemaValues(SAMPLE_VALUES);
    const map = signalValueMap.get();
    expect(map.get("sig.0")).toBe(42);
    expect(map.get("sig.1")).toBe("active");
    expect(map.get("sig.2")).toBe(true);
  });

  test("getSignalValue returns the value", () => {
    setUiSchemaValues(SAMPLE_VALUES);
    expect(getSignalValue("sig.0")).toBe(42);
  });

  test("getSignalValue returns undefined for unknown id", () => {
    setUiSchemaValues(SAMPLE_VALUES);
    expect(getSignalValue("missing")).toBeUndefined();
  });

  test("empty values → empty map", () => {
    expect(signalValueMap.get().size).toBe(0);
  });
});
