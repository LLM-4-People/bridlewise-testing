/**
 * `harness check` ASKS THE ENGINE RUNNER'S OWN SETUP DOOR (#417).
 *
 * The runner builds the candidate manifest before it runs a test, and refuses
 * a tree it cannot certify. Asked only there, a file with an extra trailing
 * newline landed through every required check and main's engine suite ran
 * zero tests. The check's candidate-format step asks the same door
 * (`scripts/verification/candidate-manifest.ts --verdict`), so the commit guard
 * and CI's required check refuse the file before it lands.
 */
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { candidateFormatStep, harnessCheck } from "../../src/workflow/harness-commands.ts";
import { createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

test("harness check refuses a tree the engine runner would refuse at setup, naming the file; the clean tree passes", async () => {
  // The root ignore file comes too: the linked dependencies (a symlinked `node_modules`) are ignored by its every-depth
  // rule, as in the checkout and the commit guard's staged tree.
  const copy = createRepositoryWorkingCopy("candidate-format-check-", { include: (path) => engineGeneratorPopulation(path) || path === ".gitignore" });
  try {
    // The clean tree's liveness asks the step alone; the whole check runs once, on the refused tree, where the
    // claim is that the step is wired into it and fails it (a second whole check cost ~18 s of CPU for nothing).
    const options = { skipTypecheck: true, skipArchitecture: true, skipInventory: true } as const;
    const clean = await candidateFormatStep(copy.engineRoot);
    assert.equal(clean.status, "pass", `a fresh copy is accepted (liveness): ${clean.message}`);
    assert.match(clean.message, /the engine runner accepts the tree \([1-9][0-9]* files\)/u);
    // The #417 shape: one tracked text file ends in an extra newline.
    appendFileSync(join(copy.engineRoot, "src", "cli.ts"), "\n");
    const refused = (await harnessCheck(copy.engineRoot, options)).result;
    assert.equal(refused.candidateFormat.status, "fail");
    assert.match(refused.candidateFormat.message, /would refuse this tree at its setup and run no test/u);
    const violations = (refused.candidateFormat.details as { violations?: readonly string[] } | null)?.violations ?? [];
    assert.ok(violations.includes("candidate-text-excess-final-newline:src%2Fcli.ts"), `the refusal names the file: ${violations.join(", ")}`);
    assert.equal(refused.allPassed, false, "the refusal fails the whole check");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
