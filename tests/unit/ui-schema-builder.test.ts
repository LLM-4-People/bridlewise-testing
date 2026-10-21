// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";
import {
  buildUiSchema,
  buildUiSchemaValues,
  executeSchemaAction,
  setSchemaCustomization,
  resetUiSchemaCache,
  UI_SCHEMA_VERSION,
} from "../../server/schema/ui-schema.ts";
import {
  registerAllExposure,
  resetAllRegistrations,
  listCustomizations,
  listSignals,
  installCustomizationConfigStore,
} from "../../server/kernel/canonical.ts";
import { readConfigRaw } from "../../server/kernel/harness-config.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { NotFoundError } from "../../server/kernel/errors.ts";

/** The values surface is per caller; these arms read it as an admin sees it. */
const ADMIN_VIEWER = { isAdmin: true } as const;

/**
 * Schema-builder tests. Verifies the UI schema merges the authored MODULES
 * with the live exposure metadata (signals, actions, customizations), serves
 * the deleted menu/panel/widget vocabulary as empty wire fields, and that
 * values/actions/customizations can be read/set.
 */

beforeEach(() => {
  // Config-bound customizations read/write through the installed config store.
  // Install an IN-MEMORY store seeded from the real config so this suite never
  // writes the on-disk `bridlewise.config.json` (test isolation) while the
  // served values still mirror the real file.
  let doc: Record<string, unknown> = readConfigRaw();
  installCustomizationConfigStore({
    configFilePath: serverConfig.harnessConfigPath,
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      doc = next;
    },
  });
  resetAllRegistrations();
  registerAllExposure();
  resetUiSchemaCache();
});

describe("buildUiSchema — structure", () => {
  test("has the correct schema version", () => {
    const schema = buildUiSchema();
    expect(schema.version).toBe(UI_SCHEMA_VERSION);
    // Asserted against the CONSTANT, not a literal. A hardcoded version string
    // makes the test fail on every deliberate bump for no reason, which trains
    // people to edit the assertion rather than read it.
    expect(schema.version).toBe(UI_SCHEMA_VERSION);
  });

  test("the folded-in side-panel surfaces exist as authored modules", () => {
    const schema = buildUiSchema();
    const ids = new Set(schema.modules.map((m) => m.id));
    for (const id of [
      "entities.projects",
      "converse.summary",
      "checks.auto",
      "trace.inspector",
      "agents.live",
    ]) {
      expect(ids.has(id), `module "${id}" missing from the built schema`).toBe(true);
    }
  });

  test("the menu/panel/widget vocabulary is DELETED — the wire serves the fields empty", () => {
    // The declarations are gone (MODULES superseded them); the fields stay on
    // the wire as empty arrays for the one release window in which the old
    // shell still exists (see buildUiSchema). An entry reappearing in any of
    // them is the deleted vocabulary growing back.
    const schema = buildUiSchema();
    expect(schema.menus).toEqual([]);
    expect(schema.panels).toEqual([]);
    expect(schema.widgets).toEqual([]);
  });

  test("no legacy.* module is synthesised any more (the bridge is gone)", () => {
    const schema = buildUiSchema();
    const legacy = schema.modules.filter((m) => m.id.startsWith("legacy."));
    expect(legacy.map((m) => m.id)).toEqual([]);
  });
});

describe("buildUiSchema — exposure integration", () => {
  test("signals are populated from the exposure registry", () => {
    const schema = buildUiSchema();
    expect(schema.signals.length).toBe(listSignals().length);
    expect(schema.signals.length).toBeGreaterThan(50);
  });

  test("signal metadata has no function fields (serializable)", () => {
    const schema = buildUiSchema();
    for (const s of schema.signals) {
      expect(s).not.toHaveProperty("value");
      expect(s).not.toHaveProperty("args");
      expect(typeof s.id).toBe("string");
      expect(typeof s.module).toBe("string");
      expect(typeof s.type).toBe("string");
    }
  });

  test("settings include backend customizations", () => {
    const schema = buildUiSchema();
    // 0 UI-declared settings + 88 backend customizations = 88+
    expect(schema.settings.length).toBeGreaterThan(50);
    const sample = schema.settings.find((s) => s.customizationId !== undefined);
    expect(sample).toBeDefined();
    expect(sample?.type).toMatch(/number|string|boolean|enum|object/);
  });

  test("actions include backend exposure actions", () => {
    const schema = buildUiSchema();
    // 1 UI-declared action + 55 backend actions = 56
    expect(schema.actions.length).toBeGreaterThan(50);
    expect(schema.actions.find((a) => a.id === "new-project")).toBeDefined();
  });

  test("schema is frozen (immutable)", () => {
    const schema = buildUiSchema();
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.menus)).toBe(true);
    expect(Object.isFrozen(schema.signals)).toBe(true);
  });

  test("schema is memoized (same object on repeat calls)", () => {
    const a = buildUiSchema();
    const b = buildUiSchema();
    expect(a).toBe(b);
  });
});

describe("buildUiSchemaValues", () => {
  test("returns current signal values", () => {
    const values = buildUiSchemaValues(ADMIN_VIEWER);
    expect(values.signals.length).toBeGreaterThan(0);
    for (const s of values.signals) {
      expect(typeof s.id).toBe("string");
      // ABSENCE IS A VALUE: a signal that could not be measured is null, and that
      // is not a type violation. A present value is always a scalar.
      expect(s.value === null || ["number", "string", "boolean"].includes(typeof s.value)).toBe(true);
    }
  });

  test("returns current customization values", () => {
    const values = buildUiSchemaValues(ADMIN_VIEWER);
    expect(values.customizations.length).toBeGreaterThan(0);
  });

  test("values are frozen", () => {
    const values = buildUiSchemaValues(ADMIN_VIEWER);
    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(values.signals)).toBe(true);
  });

  test("a value the display egress hides is flagged masked on its entry — every other entry carries no flag", () => {
    // A credential-shaped value planted through the validated write path
    // into a real free-form string row — the exact class the flag exists
    // for. The builder serves what STANDS (the route's egress walk does
    // the masking); `masked` is the server's own derived word that the
    // walk will hide the served form, so a settings surface can keep the
    // masked literal out of editable fields without pattern-matching the
    // marker spelling itself.
    const row = listCustomizations().find((c) => c.type === "string" && c.current() === "");
    expect(row, "no free-form string row standing at its empty default to prove the flag on").toBeDefined();
    const raw = "sk-live-r48-wire-flag-proof-7742a1c9";
    setSchemaCustomization(row!.id, raw);
    const values = buildUiSchemaValues(ADMIN_VIEWER);
    const entry = values.customizations.find((c) => c.id === row!.id);
    expect(entry).toBeDefined();
    expect(entry!.masked).toBe(true);
    expect(entry!.value).toBe(raw);
    for (const c of values.customizations) {
      if (c.id !== row!.id) {
        expect(c.masked, `${c.id}: an unmasked entry must carry no flag`).toBeUndefined();
      }
    }
    // Restored through the same door, the flag is gone.
    setSchemaCustomization(row!.id, "");
    const restored = buildUiSchemaValues(ADMIN_VIEWER).customizations.find((c) => c.id === row!.id);
    expect(restored?.value).toBe("");
    expect(restored?.masked).toBeUndefined();
  });
});

describe("executeSchemaAction", () => {
  test("executes a known action", () => {
    // search.clearCache is a registered action that clears the cache count.
    const result = executeSchemaAction("search.clearCache");
    expect(result).toBeDefined();
  });

  test("throws typed error for unknown action", () => {
    expect(() => executeSchemaAction("nonexistent.action")).toThrow(NotFoundError);
    expect(() => executeSchemaAction("nonexistent.action")).toThrow(/unknown action/);
  });
});

describe("setSchemaCustomization", () => {
  test("sets a known customization", () => {
    const valuesBefore = buildUiSchemaValues(ADMIN_VIEWER);
    const before = valuesBefore.customizations.find((c) => c.id === "search.threshold");
    expect(before).toBeDefined();
    setSchemaCustomization("search.threshold", 0.7);
    const valuesAfter = buildUiSchemaValues(ADMIN_VIEWER);
    const after = valuesAfter.customizations.find((c) => c.id === "search.threshold");
    expect(after?.value).toBe(0.7);
  });

  test("throws typed error for unknown customization", () => {
    expect(() => setSchemaCustomization("nonexistent.cust", 1)).toThrow(NotFoundError);
    expect(() => setSchemaCustomization("nonexistent.cust", 1)).toThrow(/unknown customization/);
  });
});
