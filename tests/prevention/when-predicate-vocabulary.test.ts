// @vitest-environment node
/**
 * Mechanical enforcement: schema-carried `when` predicates are VALID under
 * the shared evaluator.
 *
 * Binding guidelines: "deny-by-default — unknown input is an error, not a
 * silent default", "single source of truth for everything".
 *
 * THE FAILURE MODE
 *
 * A module's `when` clause is its hard visibility gate
 * (shared/module-contract.ts), carried on the served schema. A malformed
 * clause throws inside whatever renderer evaluates it; a clause comparing
 * `route` to a value that is not a real route can never be true. Both are
 * silent-forever defects in DATA, so they need a mechanical guard on the
 * data's producer — the server schema — against the grammar's one owner,
 * `shared/when-eval.ts`.
 *
 * WHAT THIS FILE NO LONGER GUARDS, AND WHY (recorded at the cutover): the
 * old class C held every predicate identifier to the CONTEXT OWNER's key
 * set (`buildWhenContext` in the old client tree). That owner died with
 * the old tree and has no successor — the cockpit does not evaluate schema
 * `when` gates client-side today; the predicates ride the wire as data (a
 * plugged consumer is future work, and the deleted context builder is
 * recoverable from git at this commit). Holding the vocabulary closed
 * requires a context owner, and a key list invented HERE would BE a second
 * context owner — the exact two-sources defect this suite exists to
 * prevent. So the closure class leaves with its owner, and what remains is
 * everything the surviving evaluator can honestly answer: the predicates
 * parse, and their route literals are real.
 *
 * DISCOVERY IS DYNAMIC: predicates come from `buildUiSchema()` (authored
 * entries and the exposure generator are both covered), the route set from
 * `ROUTE_VALUES`. Adding a module or a route requires no edit here.
 */
import { describe, test, expect, beforeAll } from "vitest";

import { evalWhen } from "../../shared/when-eval.ts";
import { ROUTE_VALUES } from "../../shared/routes.ts";
import { buildUiSchema, resetUiSchemaCache } from "../../server/schema/ui-schema.ts";
import { registerAllExposure, resetAllRegistrations } from "../../server/kernel/canonical.ts";

/** One predicate and where it came from, for a failure message that locates it. */
type Predicate = Readonly<{ expr: string; where: string }>;

let predicates: Predicate[];

beforeAll(() => {
  resetAllRegistrations();
  registerAllExposure();
  resetUiSchemaCache();
  const schema = buildUiSchema();
  const out: Predicate[] = [];
  const add = (expr: string | undefined, where: string) => {
    if (expr !== undefined && expr.trim() !== "") out.push({ expr, where });
  };
  // A module's `when` is its hard visibility gate. `relevance.emptyWhen` /
  // `urgentWhen` / boosts are deliberately NOT included: those run against a
  // module's readout scalars, a different vocabulary with a different owner.
  for (const m of schema.modules) add(m.when, `module "${m.id}"`);
  predicates = out;
});

describe("when predicates on the served schema are valid", () => {
  test("A. discovery is live (the authored module gates are present)", () => {
    // A predicate set that silently came back empty would make B and D
    // vacuous. Containment beats a count: the authored gates must actually
    // be there.
    expect(predicates.length, "no `when` predicate found in the built schema").toBeGreaterThan(0);
    const exprs = new Set(predicates.map((p) => p.expr));
    for (const gate of ["chat", "project", "run"]) {
      expect(exprs.has(gate), `the authored module gate "${gate}" is missing`).toBe(true);
    }
  });

  test("B. every predicate parses under the shared grammar", () => {
    // The empty context is the same parse-validity probe the arm trigger
    // door uses (server/blocks/arm.ts): a syntax error throws; an unknown
    // identifier resolves undefined and does not.
    const broken: string[] = [];
    for (const { expr, where } of predicates) {
      try {
        evalWhen(expr, {});
      } catch (err) {
        broken.push(`${where}: \`${expr}\` — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    expect(
      broken,
      `A malformed \`when\` clause throws inside whatever renderer evaluates it.\n${broken.join("\n")}`,
    ).toEqual([]);
  });

  test("D. every route compared in a predicate is a real Route", () => {
    const routes = new Set<string>(ROUTE_VALUES);
    const bad: string[] = [];
    for (const { expr, where } of predicates) {
      for (const m of expr.matchAll(/\broute\s*(?:==|!=)\s*'([^']*)'/g)) {
        if (!routes.has(m[1]!)) bad.push(`${where}: \`${expr}\` compares route to "${m[1]}"`);
      }
      for (const m of expr.matchAll(/\broute\s*(?:==|!=)\s*"([^"]*)"/g)) {
        if (!routes.has(m[1]!)) bad.push(`${where}: \`${expr}\` compares route to "${m[1]}"`);
      }
    }
    expect(
      bad,
      `A predicate gated on a route that does not exist can never be true. shared/routes.ts\n` +
        `owns the route set — ${[...routes].join(", ")}.\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});
