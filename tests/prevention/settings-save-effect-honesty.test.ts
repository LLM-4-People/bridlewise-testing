// @vitest-environment node
/**
 * EXP-REG-W2 — SAVE consequence must consume declared effect timing.
 *
 * The Save verb is one door for every customization. A generic
 * "applies … immediately" sentence lies for next-run knobs (farm
 * timeouts). The shipped `settingsSaveConsequence` reads the live
 * registry's `contract.effect` field.
 *
 * SUBJECT: server/blocks/settings.ts settingsSaveConsequence
 * OWNS: SAVE copy honesty vs declared effect
 * PLANT: restore "applies to everyone using this install immediately."
 * DRIVEN: settingsSaveConsequence() + listCustomizations()
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  registerAllExposure,
  resetAllRegistrations,
  listCustomizations,
  installCustomizationConfigStore,
} from "../../server/kernel/canonical.ts";
import { settingsSaveConsequence } from "../../server/blocks/settings.ts";
import { serverConfig } from "../../server/kernel/config.ts";

beforeEach(() => {
  let doc: Record<string, unknown> = {};
  installCustomizationConfigStore({
    configFilePath: serverConfig.harnessConfigPath,
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      doc = next;
    },
  });
  resetAllRegistrations();
  registerAllExposure();
});

afterEach(() => {
  resetAllRegistrations();
});

describe("settings SAVE consequence consumes declared effect", () => {
  test("the live registry actually has next-run customizations", () => {
    const nextRun = listCustomizations().filter((c) => c.contract?.effect === "next-run");
    expect(
      nextRun.length,
      "this test is about the next-run class; a registry with none would make SAVE-immediate vacuously true",
    ).toBeGreaterThan(0);
    expect(nextRun.some((c) => c.id.startsWith("intelligence.farm"))).toBe(true);
  });

  test("SAVE copy names next-run timing and does not claim immediate-only application", () => {
    const copy = settingsSaveConsequence();
    expect(copy.length, "SAVE consequence must be a real sentence").toBeGreaterThan(20);
    expect(copy.toLowerCase()).toContain("next run");
    expect(
      copy,
      "a next-run class must not be described as applying immediately",
    ).not.toMatch(/applies to everyone using this install immediately/);
  });
});
