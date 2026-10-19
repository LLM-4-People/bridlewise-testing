// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";
import {
  buildUiSchema,
  resetUiSchemaCache,
  type SettingEntry,
  type SignalEntry,
} from "../../server/schema/ui-schema.ts";
import {
  registerAllExposure,
  resetAllRegistrations,
} from "../../server/kernel/canonical.ts";

/**
 * SERVED SCHEMA ENRICHMENT — the wire proof for the registration language
 * work. The cockpit renders the SERVED text with zero cockpit edits, so the
 * verification lives at the served schema, not in component tests:
 *
 * - settings carry behavior-shaped labels (never the Title-Cased id),
 * - number settings carry printable units,
 * - effect timing is forwarded ONLY where the registration declared it
 *   (absent = the honest "not declared" line),
 * - measuredBy (the declared setting→reading linkage) is forwarded,
 * - signals forward declared `abnormal` bounds and the `timestamp` type.
 */

beforeEach(() => {
  resetAllRegistrations();
  registerAllExposure();
  resetUiSchemaCache();
});

function setting(id: string): SettingEntry {
  const entry = buildUiSchema().settings.find((s) => s.customizationId === id);
  expect(entry, `setting "${id}" must be served`).toBeDefined();
  return entry as SettingEntry;
}

function signal(id: string): SignalEntry {
  const entry = buildUiSchema().signals.find((s) => s.id === id);
  expect(entry, `signal "${id}" must be served`).toBeDefined();
  return entry as SignalEntry;
}

describe("served settings language", () => {
  test("labels are behavior-shaped, not the Title-Cased registry id", () => {
    expect(setting("search.threshold").label).toBe("Minimum match score");
    expect(setting("memory.windowSize").label).toBe("Working-memory size");
    expect(setting("tools.maxConcurrent").label).toBe("Tools running at once");
    // The raw-key law, over every served exposure setting: the normalized
    // label never equals the normalized id.
    const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const entry of buildUiSchema().settings) {
      if (entry.customizationId === undefined) continue;
      expect(
        normalize(entry.label),
        `"${entry.label}" restates "${entry.customizationId}"`,
      ).not.toBe(normalize(entry.customizationId));
    }
  });

  test("number settings serve a printable unit", () => {
    expect(setting("search.indexFreshness").unit).toBe("seconds");
    expect(setting("memory.windowSize").unit).toBe("tokens");
    expect(setting("tools.timeout").unit).toBe("milliseconds");
    for (const entry of buildUiSchema().settings) {
      if (entry.customizationId === undefined || entry.type !== "number") continue;
      expect(entry.unit, `${entry.customizationId} serves no unit`).toBeDefined();
    }
  });

  test("effect timing is served only where a real consumer was verified", () => {
    expect(setting("memory.windowSize").effect).toBe("immediate");
    expect(setting("bias.maxAuditRows").effect).toBe("immediate");
    // These three were dead stores when this test was written — the value
    // persisted and nothing read it, so claiming a timing would have been
    // fabrication. They have since been wired to real consumers (editor/
    // quality/tools/search sweep, 2026-07-26: 24 dead stores wired, 28
    // mutants killed), so a declared timing is now the honest answer and its
    // ABSENCE would be the defect. Every served customization is now backed
    // by a behavioral proof; the guard's HONESTLY_UNDECLARED list is empty
    // and asserted empty, so a regression re-appears here loudly.
    expect(setting("search.maxResults").effect).toBe("immediate");
    expect(setting("tools.timeout").effect).toBe("immediate");
    expect(setting("quality.thresholdCritical").effect).toBe("immediate");
  });

  test("measuredBy linkage is served and resolves against the served signals", () => {
    expect(setting("search.threshold").measuredBy).toBe("search.thresholdActive");
    expect(setting("bias.maxAuditRows").measuredBy).toBe("bias.auditRowCount");
    const servedSignalIds = new Set(buildUiSchema().signals.map((s) => s.id));
    let linked = 0;
    for (const entry of buildUiSchema().settings) {
      if (entry.measuredBy === undefined) continue;
      linked += 1;
      expect(servedSignalIds.has(entry.measuredBy), `${entry.customizationId} measuredBy dangles on the wire`).toBe(true);
    }
    // The invariant is "every declared measuredBy resolves", checked per entry
    // above — not a hardcoded count that silently drifts each time a measured
    // setting is added. A floor proves the loop actually examined a population.
    expect(linked, "a measuredBy population must exist for the resolve check to mean anything").toBeGreaterThan(20);
  });
});

describe("served signal enrichment", () => {
  test("declared abnormal bounds reach the wire; undeclared signals stay silent", () => {
    expect(signal("memory.corruptedEntries").abnormal).toEqual({ warnAbove: 0 });
    expect(signal("context.utilization").abnormal).toEqual({ warnAbove: 1 });
    expect(signal("hallucination.missCount").abnormal).toEqual({ warnAbove: 0 });
    expect(signal("search.queryCount").abnormal).toBeUndefined();
  });

  test("epoch instants are served as `timestamp`, not as durations", () => {
    expect(signal("awareness.lastUpdate").type).toBe("timestamp");
    expect(signal("editor.lastEditAt").type).toBe("timestamp");
  });
});
