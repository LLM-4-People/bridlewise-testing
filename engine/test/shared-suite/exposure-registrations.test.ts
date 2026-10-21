import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  registerAllExposure,
  resetAllRegistrations,
  registeredModuleNames,
} from "../../src/shared/exposure/registrations/index.ts";
import {
  countSignals,
  countActions,
  countCustomizations,
  countAll,
  listSignals,
  listActions,
  listCustomizations,
  listSignalsByModule,
  listActionsByModule,
  listCustomizationsByModule,
  readSignal,
  reportAll,
  reportJson,
  snapshot,
} from "../../src/shared/exposure/index.ts";

/**
 * EXP470 — full-registration verification (Step 5).
 *
 * After the exposure APIs were unified into ONE source of truth, this test
 * registers every module's exposure surface via `registerAllExposure` and
 * verifies the scale targets (110+ signals, 55+ actions, 80+ customizations)
 * still hold, plus the reporter + snapshot + module list are consistent.
 *
 * The customization target was 88 until the inert-control cleanup: eight
 * registered knobs (memory.decayRate, memory.retentionDays,
 * safety.maxRetries, safety.redactSecrets, safety.biasTypes,
 * learning.teacherStudentEnabled, learning.ruleFormat,
 * bias.detectionStrategy) promised capabilities their modules do not have —
 * their values could never influence any behaviour. A rendered control that
 * changes nothing is a lie about capability, so they were REMOVED rather
 * than wired to dead stores, and the scale target follows the honest count.
 */

test("exp470-registration: registerAllExposure populates 110+ signals, 55+ actions, 80+ customizations", () => {
  resetAllRegistrations();
  registerAllExposure();

  const signals = countSignals();
  const actions = countActions();
  const customizations = countCustomizations();
  const total = countAll();

  assert.ok(signals >= 110, `expected 110+ signals, got ${signals}`);
  assert.ok(actions >= 55, `expected 55+ actions, got ${actions}`);
  assert.ok(customizations >= 80, `expected 80+ customizations, got ${customizations}`);
  assert.equal(total, signals + actions + customizations);

  resetAllRegistrations();
});

test("exp470-registration: every registered module contributes at least one item", () => {
  resetAllRegistrations();
  registerAllExposure();

  for (const name of registeredModuleNames()) {
    const s = listSignalsByModule(name).length;
    const a = listActionsByModule(name).length;
    const c = listCustomizationsByModule(name).length;
    assert.ok(s + a + c > 0, `module '${name}' must contribute at least one signal/action/customization (got s=${s} a=${a} c=${c})`);
  }

  resetAllRegistrations();
});

test("exp470-registration: every signal has a dynamic value + every action is executable + every customization is readable", () => {
  resetAllRegistrations();
  registerAllExposure();

  for (const signal of listSignals()) {
    assert.equal(typeof signal.value, "function", `signal ${signal.id} value must be a function`);
    const v = readSignal(signal.id);
    // null is the signal's ABSENCE (a rate with no measured denominator, a
    // reading before its first tick): a scalar or a stated absence, never an
    // invented zero.
    assert.ok(v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean",
      `signal ${signal.id} value must be a scalar or null absence`);
  }

  let executableActions = 0;
  for (const action of listActions()) {
    assert.equal(typeof action.execute, "function", `action ${action.id} execute must be a function`);
    executableActions += 1;
  }
  assert.ok(executableActions >= 55, `expected 55+ executable actions, got ${executableActions}`);

  let readableCustomizations = 0;
  for (const customization of listCustomizations()) {
    assert.equal(typeof customization.current, "function", `customization ${customization.id} current must be a function`);
    assert.equal(typeof customization.set, "function", `customization ${customization.id} set must be a function`);
    readableCustomizations += 1;
  }
  assert.ok(readableCustomizations >= 80, `expected 80+ readable customizations, got ${readableCustomizations}`);

  resetAllRegistrations();
});

test("exp470-registration: reportAll produces a structured Markdown report with the right counts", () => {
  resetAllRegistrations();
  registerAllExposure();

  const md = reportAll();
  const lines = md.split("\n");
  assert.ok(md.includes("# Harness Exposure Report"), "report must have a title");
  assert.ok(md.includes(`- Signals: ${countSignals()}`), "report must list signal count");
  assert.ok(md.includes(`- Actions: ${countActions()}`), "report must list action count");
  assert.ok(md.includes(`- Customizations: ${countCustomizations()}`), "report must list customization count");
  assert.ok(lines.length > 100, `report must be substantial, got ${lines.length} lines`);

  resetAllRegistrations();
});

test("exp470-registration: reportJson parses + counts match the live registry", () => {
  resetAllRegistrations();
  registerAllExposure();

  const json = JSON.parse(reportJson());
  assert.equal(json.counts.signals, countSignals());
  assert.equal(json.counts.actions, countActions());
  assert.equal(json.counts.customizations, countCustomizations());
  assert.equal(json.counts.total, countAll());
  assert.equal(json.signals.length, countSignals());
  assert.equal(json.actions.length, countActions());
  assert.equal(json.customizations.length, countCustomizations());

  resetAllRegistrations();
});

test("exp470-registration: snapshot is internally consistent + frozen", () => {
  resetAllRegistrations();
  registerAllExposure();

  const snap = snapshot();
  assert.equal(snap.counts.signals, snap.signals.length);
  assert.equal(snap.counts.actions, snap.actions.length);
  assert.equal(snap.counts.customizations, snap.customizations.length);
  assert.equal(snap.counts.total, snap.counts.signals + snap.counts.actions + snap.counts.customizations);
  assert.ok(Object.isFrozen(snap), "snapshot must be frozen");
  assert.ok(Object.isFrozen(snap.counts), "snapshot counts must be frozen");

  resetAllRegistrations();
});

/**
 * ── EVERY REGISTRATION FILE IS REGISTERED, AND THE UNIVERSE IS THE DISK ───
 *
 * `registrations/shared.ts` sat in this directory and was in no import list.
 * Driven, its five signals did not exist at runtime; tree-shaking had already
 * removed its symbols from `dist/bundle.js`, and that removal is what
 * `bundleSha256` certifies — so the shipped artefact never held it and every
 * consumer agreed, correctly, that it was not there. The existing guard
 * iterated `MODULE_REGISTRATIONS` and so could only ever confirm the list
 * against itself.
 *
 * A module nobody imports HAS NO RUNTIME EXISTENCE, so a runtime check cannot
 * find this class. The only instrument that can is the filesystem, which is
 * why this one reads the directory instead of asking the program.
 *
 * (`shared.ts` was deleted rather than wired: four of its five signals counted
 * invocations of helpers that NOTHING increments, so registering them would
 * have published four permanent zeros — an unmeasured quantity presented as a
 * measurement. The fifth reported the registry's own size, which
 * `awareness.refresh` already returns.)
 */
test("exposure registrations: every file in the directory is imported by the entry point", () => {
  const directory = fileURLToPath(new URL("../../src/shared/exposure/registrations/", import.meta.url));
  const indexSource = readFileSync(join(directory, "index.ts"), "utf8");
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && name !== "index.ts")
    .sort();

  // LIVENESS — the covered population as a runtime number, floored by the
  // list it is checking, so a directory that reads empty cannot pass.
  assert.ok(files.length > 0, "the registrations directory is empty");
  assert.ok(
    files.length >= registeredModuleNames().length,
    `${files.length} registration files on disk but ${registeredModuleNames().length} in the list`,
  );

  const missing = files.filter((name) => !indexSource.includes(`"./${name}"`));
  assert.deepEqual(
    missing,
    [],
    `registration file(s) present on disk and imported by nothing: ${missing.join(", ")}. ` +
    "A file here that the entry point does not import registers nothing, exists in no bundle, " +
    "and no runtime check can see it.",
  );

  // PLANT, supplied from outside: the same check against a directory listing
  // that contains a file the index does not name must report it. The name is
  // built here rather than written as a literal the detector could filter.
  const plantedName = `${registeredModuleNames()[0]!}-not-imported.ts`;
  const planted = [...files, plantedName].filter((name) => !indexSource.includes(`"./${name}"`));
  assert.deepEqual(planted, [plantedName], "the detector must report a file the index does not import");
});
