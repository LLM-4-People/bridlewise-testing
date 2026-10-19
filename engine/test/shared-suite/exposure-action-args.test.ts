import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import {
  clearAll,
  executeAction,
  listActions,
  registerAction,
} from "../../src/shared/exposure/index.ts";
import {
  registerAllExposure,
  resetAllRegistrations,
} from "../../src/shared/exposure/registrations/index.ts";

/**
 * Action arguments: absent means ABSENT, and no action invents a measurement.
 *
 * TWO DEFECTS THIS GUARDS
 *
 * 1. `validateActionArgs` substituted the empty STRING for every absent
 *    optional arg, whatever its declared type. Two contracts broke at once:
 *    `memory.retrieve` declared `hit` as a boolean and returned `hit: ""`, and
 *    every `args?.x ?? fallback` in every action body stopped working — `""`
 *    is not nullish — so `search.query`'s documented default of 5 results
 *    silently became `Number("")`, i.e. 0. Both were observed.
 *
 * 2. Three registered actions FABRICATED the numbers they recorded:
 *    `search.query` invented a 10–60ms latency and a 50/50 cache hit,
 *    `memory.retrieve` a 70% hit and a 5–25ms latency, `quality.recheck` a
 *    50–250ms check time. Each fed an operator-facing signal
 *    (`search.avgLatency`, `search.cacheHitRate`, `memory.retrievalHitRate`,
 *    `quality.avgCheckTime`), so the harness reported invented numbers as
 *    measurements.
 */

const REGISTRATIONS_DIR = new URL("../../src/shared/exposure/registrations/", import.meta.url);

test("action args: an absent optional arg is omitted, not replaced by a placeholder", async () => {
  clearAll();
  try {
    let seen: Readonly<Record<string, unknown>> | undefined;
    registerAction({
      id: "probe.optional",
      module: "probe",
      name: "Optional",
      description: "Captures what the validator passed through.",
      args: {
        needed: { type: "string", required: true, description: "Required." },
        count: { type: "number", required: false, description: "Optional number." },
        flag: { type: "boolean", required: false, description: "Optional boolean." },
      },
      execute: async (args) => {
        seen = args;
        return { ok: true };
      },
    });

    await executeAction("probe.optional", { needed: "x" });
    assert.ok(seen !== undefined, "the action did not run");
    assert.ok(!("count" in seen), `an absent optional number must be omitted, got ${JSON.stringify(seen)}`);
    assert.ok(!("flag" in seen), `an absent optional boolean must be omitted, got ${JSON.stringify(seen)}`);
    // The point of omission: the action's own default becomes reachable again.
    assert.equal(seen.count ?? 5, 5, "`?? default` must work for an absent optional arg");
  } finally {
    clearAll();
  }
});

test("action args: a supplied optional arg keeps its declared type", async () => {
  clearAll();
  try {
    let seen: Readonly<Record<string, unknown>> | undefined;
    registerAction({
      id: "probe.typed",
      module: "probe",
      name: "Typed",
      description: "Captures the coerced args.",
      args: {
        count: { type: "number", required: false, description: "Optional number." },
        flag: { type: "boolean", required: false, description: "Optional boolean." },
      },
      execute: async (args) => { seen = args; return { ok: true }; },
    });
    await executeAction("probe.typed", { count: 3, flag: false });
    assert.equal(typeof seen?.count, "number");
    assert.equal(typeof seen?.flag, "boolean");
    assert.equal(seen?.flag, false, "an explicit `false` must survive, not be treated as absent");
  } finally {
    clearAll();
  }
});

test("action args: a missing REQUIRED arg is still a typed error", async () => {
  clearAll();
  try {
    registerAction({
      id: "probe.required",
      module: "probe",
      name: "Required",
      description: "Requires an arg.",
      args: { needed: { type: "string", required: true, description: "Required." } },
      execute: async () => ({ ok: true }),
    });
    await assert.rejects(() => executeAction("probe.required", {}), InputError);
  } finally {
    clearAll();
  }
});

test("action args: every registered action's declared types survive a full-registration round trip", async () => {
  resetAllRegistrations();
  registerAllExposure();
  try {
    const actions = listActions().filter((action) => action.args !== undefined);
    assert.ok(actions.length > 0, "dynamic discovery found no actions declaring args");
    for (const action of actions) {
      for (const [name, decl] of Object.entries(action.args!)) {
        assert.ok(
          ["number", "string", "boolean"].includes(decl.type),
          `action "${action.id}" arg "${name}" declares unsupported type "${decl.type}"`,
        );
      }
    }
  } finally {
    resetAllRegistrations();
  }
});

/**
 * No registration may synthesize a measurement. Discovered dynamically over
 * the registrations directory so a new module is covered the moment it is
 * added — the previous three offenders were all found by reading, which does
 * not scale and did not catch them.
 */
test("exposure registrations: no module fabricates the values it reports", () => {
  const files = readdirSync(REGISTRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
  assert.ok(files.length > 0, "dynamic discovery found no registration modules");

  const offenders: string[] = [];
  for (const file of files) {
    const source = readFileSync(new URL(file, REGISTRATIONS_DIR), "utf8");
    source.split("\n").forEach((line, index) => {
      if (line.includes("Math.random")) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "these registrations invent the numbers they publish as signals; measure the value or " +
      "require the caller to state it",
  );
});
