/**
 * THE PRODUCTION GRAPH'S OWNER-SCOPED ALLOWANCES (`scripts/tooling/s1-verification.ts`):
 * `node:worker_threads` is admitted only in the synchronous bounded run's owners
 * (`src/process/bounded-run-sync.ts` and `src/process/worker-bootstrap.ts`), never
 * globally, and the one non-literal module load admitted is the worker prelude's,
 * which imports only a declared entry. Every other module keeps the refusal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { nonliteralLoadViolation, productionBuiltinViolation } from "../../scripts/tooling/s1-verification.ts";

test("node:worker_threads is admitted in its two owners and refused in any other production module", () => {
  assert.equal(productionBuiltinViolation("node:worker_threads", "src/process/bounded-run-sync.ts"), undefined);
  assert.equal(productionBuiltinViolation("node:worker_threads", "src/process/worker-bootstrap.ts"), undefined);
  assert.equal(productionBuiltinViolation("node:worker_threads", "src/git/tree-reader.ts"), "production-effect-builtin:node:worker_threads");
  assert.equal(productionBuiltinViolation("node:worker_threads", "src/process/supervised-run.ts"), "production-effect-builtin:node:worker_threads");
  // The global allowances are unchanged, and an unlisted builtin stays refused everywhere, its owners included.
  assert.equal(productionBuiltinViolation("node:fs", "src/git/tree-reader.ts"), undefined);
  assert.equal(productionBuiltinViolation("node:vm", "src/process/bounded-run-sync.ts"), "production-effect-builtin:node:vm");
});

test("the worker prelude's gated load is the one non-literal module load admitted", () => {
  assert.equal(nonliteralLoadViolation("src/process/worker-bootstrap.ts"), undefined);
  assert.equal(nonliteralLoadViolation("src/process/bounded-run-sync.ts"), "nonliteral-module-load:src/process/bounded-run-sync.ts");
  assert.equal(nonliteralLoadViolation("src/cli.ts"), "nonliteral-module-load:src/cli.ts");
});
