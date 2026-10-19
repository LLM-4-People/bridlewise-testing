import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, invoke, parseSuccess, errorCode } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B07-CONTROL": () => {
    const root = makeRuntimeCandidate();
    const output = parseSuccess(invoke(root));
    assert.equal(output.stage, "s1-preflight-only");
    assert.equal(output.harnessReady, false);
    assert.equal((output.trust as Record<string, unknown>).claim, "integrity-only-not-authenticity");
  },
  "S1-B07-FAILURE": () => {
    const root = makeRuntimeCandidate();
    for (const args of [
      ["--config", join(root, "bridlewise.config.json"), "preflight"],
      ["agent-run", root, "prompt"],
      ["request-submit", "id", "prompt"],
      ["init"],
    ]) {
      const result = invoke(root, args);
      assert.equal(errorCode(result), "command_unavailable");
      assert.equal(result.stdout, "");
    }
  },
  "S1-B07-HOSTILE-REAL": () => {
    const root = makeRuntimeCandidate();
    const marker = join(root, "forbidden-marker");
    const payload = `;require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`;
    const result = invoke(root, ["agent-run", root, payload]);
    assert.equal(errorCode(result), "command_unavailable");
    assert.equal(existsSync(marker), false);
    for (const removed of ["core.ts", "store.ts", "state-boundary.ts", "path-capability.ts"]) {
      assert.equal(existsSync(join(root, "src", removed)), false);
    }
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
