import assert from "node:assert/strict";
import test from "node:test";

import {
  clearAll,
  clearExposureModules,
  countExposureModules,
  exposureModuleTitle,
  exposureModuleViolation,
  getExposureModule,
  humanizeModuleId,
  isValidModuleId,
  listCustomizations,
  listExposureModules,
  registerCustomization,
  registerExposureModule,
  undeclaredModules,
  unregisterExposureModule,
  MIN_MODULE_PURPOSE_WORDS,
  type ExposureModule,
} from "../../src/shared/exposure/index.ts";
import {
  registerAllExposure,
  registeredModuleNames,
  resetAllRegistrations,
} from "../../src/shared/exposure/registrations/index.ts";

/**
 * THE MODULE DECLARATION — the category primitive, mutation-tested.
 *
 * The property under test is the one that makes control surfaces DERIVED
 * rather than authored: a settings surface groups by what the registry
 * declares, so a module registered tomorrow appears with a real name and
 * nothing has to be edited in a component. Two halves:
 *
 *   A. the LANGUAGE rules — every clause has a mutant that MUST be rejected
 *      and a compliant twin that MUST pass, so deleting a clause fails a
 *      named test here;
 *   B. the COVERAGE rule — every module that owns a registered customization
 *      declares a category. This is the clause that makes a hand-authored
 *      map in a consumer unnecessary AND detectable: drop one declaration and
 *      this fails, which is the mutation proof for "derived, not authored".
 */

/** A compliant declaration, overridable per test. */
function decl(overrides: Partial<ExposureModule> = {}): ExposureModule {
  return {
    id: "probe",
    title: "Trial runs",
    purpose: "What the trial area decides when it runs, in plain words for a reader.",
    ...overrides,
  };
}

// ── A. the language rules, each with its mutant ───────────────────────────

test("module declaration: a compliant declaration registers", () => {
  clearExposureModules();
  try {
    assert.equal(exposureModuleViolation(decl()), null);
    const out = registerExposureModule(decl());
    assert.equal(out.title, "Trial runs");
    assert.equal(countExposureModules(), 1);
  } finally {
    clearExposureModules();
  }
});

test("module declaration: MUTANT — a title that restates the id is rejected", () => {
  clearExposureModules();
  try {
    // "Probe" is the id Title-Cased: the same non-information the namespace
    // already carried, which is the entire reason this primitive exists.
    const violation = exposureModuleViolation(decl({ title: "Probe" }));
    assert.notEqual(violation, null);
    assert.match(String(violation), /restates the id/u);
    assert.throws(() => registerExposureModule(decl({ title: "Probe" })), /restates the id/u);
    // …and the compliant twin passes, so the clause is not rejecting everything.
    assert.equal(exposureModuleViolation(decl({ title: "Trial runs" })), null);
  } finally {
    clearExposureModules();
  }
});

test("module declaration: MUTANT — an empty title is rejected", () => {
  assert.match(String(exposureModuleViolation(decl({ title: "   " }))), /empty title/u);
});

test("module declaration: MUTANT — a purpose too short to be a sentence is rejected", () => {
  const short = "Probe settings.";
  assert.ok(short.split(/\s+/u).length < MIN_MODULE_PURPOSE_WORDS);
  const violation = exposureModuleViolation(decl({ purpose: short }));
  assert.notEqual(violation, null);
  assert.match(String(violation), /at least/u);
  // The compliant twin: exactly the floor passes.
  const atFloor = "One two three four five six";
  assert.equal(atFloor.split(/\s+/u).length, MIN_MODULE_PURPOSE_WORDS);
  assert.equal(exposureModuleViolation(decl({ purpose: atFloor })), null);
});

test("module declaration: MUTANT — a purpose that only restates the title is rejected", () => {
  const violation = exposureModuleViolation(
    decl({ title: "One two three four five six", purpose: "One, two three four five six!" }),
  );
  assert.match(String(violation), /restates the title/u);
});

test("module declaration: MUTANT — implementation jargon outside a parenthetical is rejected", () => {
  const jargon = decl({
    purpose: "How the regex is applied to each candidate before a result is returned.",
  });
  assert.match(String(exposureModuleViolation(jargon)), /implementation vocabulary/u);
  // Precision one level deeper, inside a parenthetical, is allowed.
  const parenthetical = decl({
    purpose: "How each candidate is matched (the underlying matcher is a regex) before a result is returned.",
  });
  assert.equal(exposureModuleViolation(parenthetical), null);
});

test("module declaration: MUTANT — a dotted or empty id is rejected", () => {
  assert.match(String(exposureModuleViolation(decl({ id: "search.threshold" }))), /namespace token/u);
  assert.match(String(exposureModuleViolation(decl({ id: "" }))), /namespace token/u);
  assert.equal(isValidModuleId("search"), true);
  assert.equal(isValidModuleId("sharedMemory"), true);
  assert.equal(isValidModuleId("search.threshold"), false);
});

test("module declaration: one namespace cannot carry two category names", () => {
  clearExposureModules();
  try {
    registerExposureModule(decl());
    // An IDENTICAL re-declaration is idempotent (registration files are).
    assert.doesNotThrow(() => registerExposureModule(decl()));
    assert.equal(countExposureModules(), 1);
    // A DIFFERENT one is refused rather than silently overwriting: two names
    // for one namespace is exactly the drift this primitive removes.
    assert.throws(
      () => registerExposureModule(decl({ title: "Something else entirely" })),
      /already declared/u,
    );
  } finally {
    clearExposureModules();
  }
});

// ── The declared-first / derived-otherwise resolution ─────────────────────

test("module title: declared wins, and an undeclared module still gets a spelled-out name", () => {
  clearExposureModules();
  try {
    registerExposureModule(decl());
    assert.equal(exposureModuleTitle("probe"), "Trial runs");
    // NEVER a blank and never the raw token: the fallback is honest, so a
    // module declared tomorrow renders sensibly before anyone writes its words.
    assert.equal(exposureModuleTitle("sharedMemory"), "Shared Memory");
    assert.equal(humanizeModuleId("some-new-area"), "Some new area");
    assert.equal(getExposureModule("sharedMemory"), undefined);
  } finally {
    clearExposureModules();
  }
});

test("undeclaredModules names the gap rather than hiding it", () => {
  clearExposureModules();
  try {
    registerExposureModule(decl());
    assert.deepEqual(undeclaredModules(["probe"]), []);
    assert.deepEqual(undeclaredModules(["probe", "ghost", "ghost"]), ["ghost"]);
    unregisterExposureModule("probe");
    assert.deepEqual(undeclaredModules(["probe"]), ["probe"]);
  } finally {
    clearExposureModules();
  }
});

test("clearAll clears the declarations too — a reset leaves no other module's category standing", () => {
  clearAll();
  try {
    registerExposureModule(decl());
    assert.equal(countExposureModules(), 1);
    clearAll();
    assert.equal(countExposureModules(), 0);
  } finally {
    clearAll();
  }
});

// ── B. COVERAGE — the clause that makes the grouping derivable ────────────

test("COVERAGE: every module that owns a customization declares its category", () => {
  resetAllRegistrations();
  try {
    registerAllExposure();

    const owning = [...new Set(listCustomizations().map((c) => c.module))];
    assert.ok(owning.length > 0, "no customizations registered — the sweep proves nothing");

    // THE PROPERTY: a settings surface can group every served setting under a
    // declared, plain-words category. A missing declaration is named here, not
    // papered over by a consumer's own table.
    assert.deepEqual(
      undeclaredModules(owning),
      [],
      "every namespace owning a setting must declare its category in its registration file",
    );

    // …and the roster agrees with the registrations aggregator, so a module
    // added to `MODULE_REGISTRATIONS` without a declaration fails here.
    for (const name of registeredModuleNames()) {
      assert.notEqual(
        getExposureModule(name),
        undefined,
        `module "${name}" is registered but declares no category`,
      );
    }
  } finally {
    resetAllRegistrations();
  }
});

test("COVERAGE MUTANT: removing one declaration fails the coverage rule", () => {
  resetAllRegistrations();
  try {
    registerAllExposure();
    const owning = [...new Set(listCustomizations().map((c) => c.module))];
    assert.deepEqual(undeclaredModules(owning), []);

    // Break the fix: drop one module's category and prove the guard notices.
    assert.equal(unregisterExposureModule("search"), true);
    assert.deepEqual(undeclaredModules(owning), ["search"]);
    // …and the surface would fall back to the spelled-out namespace, which is
    // exactly the thing the declaration exists to replace.
    assert.equal(exposureModuleTitle("search"), "Search");
  } finally {
    resetAllRegistrations();
  }
});

test("COVERAGE: every declared category is plain words, not the namespace restated", () => {
  resetAllRegistrations();
  try {
    registerAllExposure();
    const seen = new Map<string, string>();
    for (const m of listExposureModules()) {
      assert.equal(
        exposureModuleViolation(m),
        null,
        `module "${m.id}" declares words its own validator would reject`,
      );
      // Two categories with the same visible name are two categories a reader
      // cannot tell apart.
      const clash = seen.get(m.title.toLowerCase());
      assert.equal(clash, undefined, `"${m.title}" is declared by both ${clash} and ${m.id}`);
      seen.set(m.title.toLowerCase(), m.id);
    }
    assert.ok(listExposureModules().length >= 11);
  } finally {
    resetAllRegistrations();
  }
});

test("a customization cannot smuggle in a module the declarations never met", () => {
  resetAllRegistrations();
  try {
    registerAllExposure();
    let v = 1;
    registerCustomization({
      id: "ghost.knob",
      module: "ghost",
      name: "How many trial passes run",
      description: "How many trial passes run before the result is reported. Higher = slower, steadier answers.",
      type: "number",
      default: 1,
      current: () => v,
      set: (next) => {
        v = Number(next);
      },
    });
    const owning = [...new Set(listCustomizations().map((c) => c.module))];
    assert.deepEqual(undeclaredModules(owning), ["ghost"]);
  } finally {
    resetAllRegistrations();
  }
});
