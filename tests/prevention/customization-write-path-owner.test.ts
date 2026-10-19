// @vitest-environment node
/**
 * THE CONTROL-PLANE GUARD — every rendered control must be real.
 *
 * The UI schema advertises all 88 registered customizations to the frontend
 * as `settings` entries, each carrying a `type` and (for numbers) `min`/`max`
 * and (for enums) the legal values. The settings panel renders a control per
 * entry and writes through the block action
 * `POST /api/b/settings.customizations/set` (the legacy
 * `PUT /api/schema/ui/customizations/:id` beside it) — both doors call
 * `setSchemaCustomization`. Two failures of that promise are indistinguishable
 * from working software until you look at the state afterwards:
 *
 *   UNVALIDATED — the write path ignored the declared contract. The schema
 *     told the UI "0..1", the UI drew a slider with those bounds, and the
 *     server accepted 5000 anyway. (Real defect: `setSchemaCustomization`
 *     called the registry entry's raw `set` instead of the registry's
 *     validating `setCustomizationValue`, so the declared min/max/type were
 *     enforced NOWHERE on the write path.)
 *
 *   INERT — the control changes nothing. The setter is a no-op or the getter
 *     returns a constant, so the value snaps back on the next read. A
 *     rendered control that cannot take effect is a lie about capability,
 *     exactly as prohibited as fake data.
 *
 * DYNAMIC DISCOVERY: the option list comes from `listCustomizations()` — the
 * live registry — never from a list in this file. A customization registered
 * tomorrow is exercised tomorrow with no edit here. Likewise the probe VALUES
 * are computed from each entry's own declared metadata (type, min, max, enum),
 * so a new type or a changed bound needs no edit either.
 *
 * Every customization is exercised through the PUBLIC write path
 * (`setSchemaCustomization` — what the route calls), set → read back →
 * restored, and then probed with a value its own contract forbids.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import {
  registerAllExposure,
  listCustomizations,
  installCustomizationConfigStore,
  type Customization,
} from "../../server/kernel/canonical.ts";
import { setSchemaCustomization } from "../../server/schema/ui-schema.ts";
import { NotFoundError, SettingValueRefusedError } from "../../server/kernel/errors.ts";
import { ConfigWriteLockTimeout } from "../../engine/src/kernel/errors.ts";
import { serverConfig } from "../../server/kernel/config.ts";

import { modulePath } from "../helpers/module-resolver.ts";
type Value = number | string | boolean | Readonly<Record<string, unknown>>;

beforeAll(() => {
  // Config-bound customizations write through the installed config store.
  // Install an IN-MEMORY store so this suite never writes the real
  // `bridlewise.config.json` (test isolation: the file is not a test
  // fixture, and a mid-run crash must not leave it drifted). Seeded empty —
  // every knob reads its declared default, which is all the round-trip probes
  // need.
  let doc: Record<string, unknown> = {};
  installCustomizationConfigStore({
    configFilePath: serverConfig.harnessConfigPath,
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      doc = next;
    },
  });
  registerAllExposure();
});

/**
 * A value INSIDE the customization's declared contract but different from
 * the current one — computed from the declared metadata, never listed.
 * `null` when the contract admits no second legal value (a single-member
 * enum, or a number whose min equals its max) — those cannot be round-tripped
 * and are reported rather than silently skipped.
 */
function inContractAlternative(c: Customization): Value | null {
  switch (c.type) {
    case "number": {
      const current = c.current() as number;
      const min = c.min ?? current - 1;
      const max = c.max ?? current + 1;
      for (const candidate of [min, max, (min + max) / 2, Math.round((min + max) / 2)]) {
        if (candidate !== current && candidate >= min && candidate <= max) return candidate;
      }
      return null;
    }
    case "boolean":
      return !(c.current() as boolean);
    case "enum": {
      const current = c.current();
      return (c.enum ?? []).find((v) => v !== current) ?? null;
    }
    case "string":
      return `${String(c.current())}-roundtrip-probe`;
    case "object":
      return { roundtripProbe: true };
    default:
      return null;
  }
}

/**
 * A value the customization's own declaration forbids — again derived from
 * the metadata: one past `max`, one below `min`, a member the enum does not
 * contain, or simply the wrong primitive type.
 */
function outOfContractValue(c: Customization): Value {
  switch (c.type) {
    case "number":
      if (c.max !== undefined) return c.max + 1;
      if (c.min !== undefined) return c.min - 1;
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    case "enum":
      return "__not_a_member_of_this_enum__";
    case "string":
      return 12345;
    case "object":
      return "not-an-object";
    default:
      return "unknown-type-probe";
  }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Customizations whose `set` is a KNOWN no-op, with the harness registration
 * that must be fixed. Every entry is a live defect, not an exemption: the
 * assertion below is an EQUALITY, so an entry that gets fixed upstream fails
 * this test until it is deleted from here, and a newly-inert control fails it
 * immediately. The registrations live in the harness repository
 * (`integration/src/shared/exposure/registrations/`), outside this
 * repository's ownership, which is the only reason they are tolerated at all.
 *
 * Discovered by this test on the day it was written (12 of 88).
 */
const KNOWN_INERT: Readonly<Record<string, string>> = Object.freeze({
  // EMPTY — deliberately. All 12 quarantined controls were resolved upstream
  // (2026-07-26): nine wired to real module state with behavioral proof
  // (set -> different module outcome -> restore), and three REMOVED from the
  // registrations because the capability they promised does not exist
  // (safety.biasTypes, bias.detectionStrategy — plus six more found by fresh
  // probes: memory.decayRate, memory.retentionDays, safety.maxRetries,
  // safety.redactSecrets, learning.teacherStudentEnabled, learning.ruleFormat).
  // Registered customizations are now 80, all live. The equality assertion
  // below keeps this map honest in both directions: a NEW inert control
  // fails the probe, and a control fixed upstream fails until removed here.
});

describe("customization write path — every registered option is validated", () => {
  test("the registry is populated (the discovery source is real)", () => {
    expect(listCustomizations().length).toBeGreaterThan(0);
  });

  test("EVERY customization rejects a value its own declaration forbids", () => {
    const accepted: string[] = [];
    for (const c of listCustomizations()) {
      const original = c.current();
      const bad = outOfContractValue(c);
      let rejected = false;
      try {
        setSchemaCustomization(c.id, bad);
      } catch (err) {
        rejected = true;
        // Deny-by-default with the SHARED taxonomy: a refused value is a
        // TYPED guided refusal (428, the family the client renders as
        // REFUSED in the sheet), never a raw Error and never a 500. The
        // sentence must also be plain words addressed to the reader — the
        // registry's internal vocabulary never reaches the sheet.
        expect(err, `${c.id}: rejection must use the typed error hierarchy`).toBeInstanceOf(
          SettingValueRefusedError,
        );
        expect(err).toMatchObject({ statusCode: 428, code: "invalid_customization_value" });
        expect((err as Error).message, `${c.id}: the refusal sentence is the reader's words`).toMatch(
          /^the setting "/,
        );
      }
      if (!rejected) {
        accepted.push(
          `${c.id} (type=${c.type}, min=${String(c.min)}, max=${String(c.max)}) accepted ${JSON.stringify(bad)}`,
        );
        // Put it back so one violation does not cascade.
        try {
          setSchemaCustomization(c.id, original);
        } catch {
          /* already reported */
        }
      }
    }
    expect(
      accepted,
      "Customizations accepted a value their own declared contract forbids — the write path " +
        "is not enforcing the schema it advertises:\n" + accepted.join("\n"),
    ).toEqual([]);
  });

  test("an out-of-range write leaves the value UNCHANGED (no clamping, no partial write)", () => {
    for (const c of listCustomizations()) {
      if (c.type !== "number" || c.max === undefined) continue;
      const before = c.current();
      try {
        setSchemaCustomization(c.id, c.max + 1);
      } catch {
        /* expected */
      }
      expect(c.current(), `${c.id} must be untouched by a rejected write`).toStrictEqual(before);
    }
  });

  test("an unknown customization id is a typed 404, not a silent no-op", () => {
    expect(() => setSchemaCustomization("definitely.not.registered", 1)).toThrow(NotFoundError);
  });

  test("a typed write failure keeps its own code (the config write lock's timeout is not a value refusal)", () => {
    // The live shape: the config write lock times out while the sheet saves a
    // value, and the write layer's adapter throws the typed timeout —
    // measured live, the refusal then arrived re-coded as
    // `invalid_customization_value`, telling the user their value was wrong
    // when it was the write that could not happen. The value-refusal
    // re-coding belongs to the value-shaped refusals alone (the registry's
    // bounds sentence, the config gate's schema sentence); any other typed
    // failure must keep its own code so the status vocabulary can name it.
    const configBound = listCustomizations().find((c) => c.configPath !== undefined);
    expect(configBound, "a config-bound customization must exist to probe the write layer").toBeDefined();
    const probeValue = configBound!.current();
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => ({}),
      writeDocument: () => {
        throw new ConfigWriteLockTimeout(
          "could not acquire the config write lock within 10000ms",
        );
      },
    });
    try {
      let thrown: unknown;
      try {
        setSchemaCustomization(configBound!.id, probeValue);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "the locked write must fail, not silently succeed").toBeDefined();
      expect(thrown).not.toBeInstanceOf(SettingValueRefusedError);
      expect(
        (thrown as { code?: unknown }).code,
        "the write layer's typed code must survive the setter — a lock timeout is a " +
          "transient refusal, never a verdict on the value",
      ).toBe("config_write_lock_timeout");
    } finally {
      // Restore the suite's in-memory store so later describes keep their
      // isolation from the real config file.
      let doc: Record<string, unknown> = {};
      installCustomizationConfigStore({
        configFilePath: serverConfig.harnessConfigPath,
        readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
        writeDocument: (next) => {
          doc = next;
        },
      });
    }
  });
});

describe("customization write path — no rendered control is inert", () => {
  test("EVERY customization round-trips: set an in-contract value, read it back, restore", () => {
    const inert: string[] = [];
    const unroundtrippable: string[] = [];

    for (const c of listCustomizations()) {
      const original = c.current();
      const alternative = inContractAlternative(c);
      if (alternative === null) {
        unroundtrippable.push(`${c.id} (type=${c.type}) — contract admits no second legal value`);
        continue;
      }
      setSchemaCustomization(c.id, alternative);
      const readBack = c.current();
      if (!sameValue(readBack, alternative)) {
        inert.push(
          `${c.id} (type=${c.type}) — set ${JSON.stringify(alternative)}, read back ` +
            `${JSON.stringify(readBack)}${KNOWN_INERT[c.id] !== undefined ? "" : "  ← NEW"}`,
        );
      }
      setSchemaCustomization(c.id, original);
      expect(c.current(), `${c.id} must restore to its original value`).toStrictEqual(original);
    }

    // Equality, not subset: a NEW inert control fails, and a control FIXED
    // upstream also fails until its entry is removed from KNOWN_INERT — the
    // quarantine cannot go stale in either direction.
    const inertIds = inert.map((line) => line.split(" ")[0]).sort();
    expect(
      inertIds,
      "Inert controls changed. A control whose setter does nothing must not be rendered as " +
        "though it works. Details:\n" + inert.join("\n"),
    ).toEqual(Object.keys(KNOWN_INERT).sort());

    // Every quarantined id must still be a registered customization —
    // otherwise the quarantine is describing something that no longer exists.
    const registered = new Set(listCustomizations().map((c) => c.id));
    for (const id of Object.keys(KNOWN_INERT)) {
      expect(registered.has(id), `KNOWN_INERT lists "${id}" which is not registered`).toBe(true);
    }
    expect(unroundtrippable, "customizations with no second legal value").toEqual([]);
  });
});

describe("customization write path — one owner, structurally", () => {
  const UI_SCHEMA_SRC = readFileSync(modulePath("ui-schema.ts"), "utf8");

  test("setSchemaCustomization writes through the VALIDATING registry setter", () => {
    expect(
      UI_SCHEMA_SRC,
      "the write path must call setCustomizationValue (which validates against the " +
        "declared contract), not the registry entry's raw setter",
    ).toContain("setCustomizationValue(customizationId, value)");
  });

  test("no server file calls a customization entry's raw `.set(...)`", () => {
    // `getCustomization(id)` hands back the raw entry, whose `set` skips the
    // registry's validation for every hand-written registration. Reaching it
    // is what the fix removed; this keeps it removed.
    const rawSetCalls = [...UI_SCHEMA_SRC.matchAll(/\bcust(?:omization)?\.set\s*\(/g)];
    expect(
      rawSetCalls.map((m) => m[0]),
      "server/schema/ui-schema.ts must not call the raw entry setter",
    ).toEqual([]);
  });
});
