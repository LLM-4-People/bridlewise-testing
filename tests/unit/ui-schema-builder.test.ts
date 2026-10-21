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
  readSignal,
  installCustomizationConfigStore,
} from "../../server/kernel/canonical.ts";
import { readConfigRaw } from "../../server/kernel/harness-config.ts";
import { withConfigDocumentSnapshot } from "../../engine/src/shared/exposure/config-binding.ts";
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

  test("one values build reads the config document ONCE, not once per customization", () => {
    // The endpoint serves every config-bound customization. Before the
    // snapshot scope each value read the store's document itself (a file
    // read and parse per customization), which made the route the profile's
    // slowest API call. Count the store's reads: one build, one document.
    let doc: Record<string, unknown> = readConfigRaw();
    let reads = 0;
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => {
        reads += 1;
        return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      },
      writeDocument: (next) => {
        doc = next;
      },
    });
    resetAllRegistrations();
    registerAllExposure();
    // Registration seeds each knob from the document — that cost belongs to
    // boot, not to a values build. Count only the build.
    reads = 0;
    const customizations = listCustomizations().length;
    expect(customizations).toBeGreaterThan(10);
    const values = buildUiSchemaValues(ADMIN_VIEWER);
    expect(values.customizations.length).toBeGreaterThan(0);
    expect(reads, `${String(customizations)} customizations must not cost ${String(reads)} document reads`).toBe(1);
  });

  test("the snapshot scope is cleared by a throw and never leaks into the next read", () => {
    let doc: Record<string, unknown> = readConfigRaw();
    let reads = 0;
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => {
        reads += 1;
        return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      },
      writeDocument: (next) => {
        doc = next;
      },
    });
    expect(() => withConfigDocumentSnapshot(() => {
      throw new Error("the build failed mid-scope");
    })).toThrow("the build failed mid-scope");
    const before = reads;
    listCustomizations()[0]!.current();
    expect(reads, "the scope must not outlive its build").toBe(before + 1);
  });

  test("a store that refuses: the values build still answers, each value exactly as its read alone would, from ONE read", () => {
    // The defect (GitHub CI shard 9, 64fd622d): the snapshot read the document
    // at the scope's entry and let the store's refusal escape, so a settings
    // file gone bad at runtime made `/api/schema/ui/values` a 503 instead of
    // the snapshot that publishes the store's own state. The snapshot changes
    // what a build COSTS, never what it serves: inside it, each value is
    // served or refused exactly as its read alone outside it would be.
    const failure = Object.assign(new Error("config_unreadable: the settings file is not valid JSON"), { code: "config_json_invalid" });
    const doc: Record<string, unknown> = readConfigRaw();
    let reads = 0;
    let refusing = false;
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => {
        reads += 1;
        if (refusing) throw failure;
        return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
      },
      writeDocument: () => {
        throw new Error("a values build never writes");
      },
    });
    const healthy = buildUiSchemaValues(ADMIN_VIEWER);
    refusing = true;
    const readsAlone = (read: () => unknown): boolean => {
      try {
        read();
        return true;
      } catch {
        return false;
      }
    };
    const signalsAlone = healthy.signals.map((s) => s.id).filter((id) => readsAlone(() => readSignal(id)));
    const customizationsAlone = healthy.customizations.map((entry) => entry.id)
      .filter((id) => readsAlone(() => listCustomizations().find((c) => c.id === id)!.current()));
    expect(signalsAlone.length, "values that need no document exist, so the comparison is not vacuous").toBeGreaterThan(0);
    expect(signalsAlone.length, "values that need the document exist, so the refusal is exercised").toBeLessThan(healthy.signals.length);
    reads = 0;
    const refused = buildUiSchemaValues(ADMIN_VIEWER);
    expect(reads, "the refusing store is read once per build, not once per value").toBe(1);
    expect(refused.signals.map((s) => s.id), "every signal its own read can serve is served").toEqual(signalsAlone);
    expect(refused.customizations.map((entry) => entry.id), "every customization its own read can serve is served").toEqual(customizationsAlone);
    const bound = listCustomizations().filter((c) => c.configPath !== undefined).map((c) => c.id);
    expect(bound.filter((id) => refused.customizations.some((entry) => entry.id === id)), "no config-bound value is served from a substitute").toEqual([]);
  });

  test("one setting whose read fails is dropped alone: every other value is still served", () => {
    const victim = listCustomizations().find((c) => c.configPath !== undefined)!;
    const healthy = buildUiSchemaValues(ADMIN_VIEWER);
    expect(healthy.customizations.some((entry) => entry.id === victim.id), "the victim is served while healthy").toBe(true);
    const doc: Record<string, unknown> = readConfigRaw();
    let reads = 0;
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => {
        reads += 1;
        // A good document with ONE bad leaf: reading the victim's path throws.
        const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
        const segments = victim.configPath!.split(".");
        let parent = copy;
        for (const segment of segments.slice(0, -1)) {
          if (typeof parent[segment] !== "object" || parent[segment] === null) parent[segment] = {};
          parent = parent[segment] as Record<string, unknown>;
        }
        Object.defineProperty(parent, segments.at(-1)!, {
          enumerable: true,
          get: () => {
            throw new Error(`the stored value of ${victim.configPath!} cannot be read`);
          },
        });
        return copy;
      },
      writeDocument: () => {
        throw new Error("a values build never writes");
      },
    });
    const values = buildUiSchemaValues(ADMIN_VIEWER);
    expect(reads).toBe(1);
    expect(values.customizations.map((entry) => entry.id), "only the bad setting is missing").toEqual(
      healthy.customizations.map((entry) => entry.id).filter((id) => id !== victim.id),
    );
    expect(values.signals.map((s) => s.id)).toEqual(healthy.signals.map((s) => s.id));
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
