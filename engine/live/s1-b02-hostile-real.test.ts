/**
 * THE LIVE SUITE'S S1 SCENARIO S1-B02-HOSTILE-REAL — moved here, byte for byte, from the
 * hermetic family file `test/s1-scenarios/b02.test.ts` (decision
 * TEST-CONFINEMENT-SELF-BIND). It needs a REAL supplementary group: its
 * foreign-owner fixture is `chownSync(<config>, uid, <another group of this
 * user>)`, and a test run whose checkout is read-only runs in an unprivileged
 * user namespace that can map only the user's own group, so that chown is
 * EINVAL there. The live suite is unconfined by design (real host facts) and
 * runs in CI's engine job (`npm run test:live:s1`). The S1 registry discovers
 * it here (`test/s1-scenarios-registry.test.ts`).
 */
import assert from "node:assert/strict";
import { chmodSync, chownSync, cpSync, linkSync, lstatSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, invoke, invokeBootstrap, errorCode, config, raceRuntime } from "../test/support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B02-HOSTILE-REAL": async () => {
    const setupLinked = makeRuntimeCandidate();
    const setupLinkedConfig = join(setupLinked, "bridlewise.config.json");
    chmodSync(setupLinkedConfig, 0o664);
    renameSync(setupLinkedConfig, `${setupLinkedConfig}.real`);
    symlinkSync(`${setupLinkedConfig}.real`, setupLinkedConfig);
    const linkedSetup = invokeBootstrap(setupLinked);
    assert.equal(errorCode(linkedSetup), "bootstrap_config_invalid");
    assert.equal(linkedSetup.stdout, "");
    assert.equal(
      linkedSetup.stderr,
      '{"action":"bootstrap-config-permissions","error":"bootstrap_config_invalid","result":"denied","schemaVersion":1}\n',
    );
    assert.equal(lstatSync(`${setupLinkedConfig}.real`).mode & 0o7777, 0o664);
    assert.doesNotMatch(linkedSetup.stderr, new RegExp(setupLinked));

    const setupForeignOwner = makeRuntimeCandidate();
    const setupForeignConfig = join(setupForeignOwner, "bridlewise.config.json");
    const foreignGroup = process.getgroups!().find((group) => group !== process.getgid!());
    assert.notEqual(foreignGroup, undefined, "bootstrap owner fixture requires a supplementary group");
    chmodSync(setupForeignConfig, 0o664);
    chownSync(setupForeignConfig, process.getuid!(), foreignGroup!);
    assert.equal(errorCode(invokeBootstrap(setupForeignOwner)), "bootstrap_owner_mismatch");
    assert.equal(lstatSync(setupForeignConfig).mode & 0o7777, 0o664);

    const setupPathOverride = makeRuntimeCandidate();
    const setupPathConfig = join(setupPathOverride, "bridlewise.config.json");
    chmodSync(setupPathConfig, 0o664);
    assert.equal(
      errorCode(invokeBootstrap(setupPathOverride, ["--root", "/tmp/attacker-selected-root"])),
      "bootstrap_arguments_invalid",
    );
    assert.equal(lstatSync(setupPathConfig).mode & 0o7777, 0o664);
    // The CLI refuses the insecure document before any command runs (a refused
    // configuration is never "proceed unprotected"), and it does not repair it.
    assert.equal(errorCode(invoke(setupPathOverride, ["bootstrap-permissions"])), "config_mode_insecure");
    assert.equal(lstatSync(setupPathConfig).mode & 0o7777, 0o664);
    // With a document it accepts, the permission bootstrap is still not a CLI command.
    chmodSync(setupPathConfig, 0o600);
    assert.equal(errorCode(invoke(setupPathOverride, ["bootstrap-permissions"])), "command_unavailable");

    const linked = makeRuntimeCandidate();
    const configPath = join(linked, "bridlewise.config.json");
    renameSync(configPath, `${configPath}.real`);
    symlinkSync(`${configPath}.real`, configPath);
    assert.equal(errorCode(invoke(linked)), "repository_symlink_denied");

    const hardlinked = makeRuntimeCandidate();
    const hardConfig = join(hardlinked, "bridlewise.config.json");
    renameSync(hardConfig, `${hardConfig}.real`);
    linkSync(`${hardConfig}.real`, hardConfig);
    assert.equal(errorCode(invoke(hardlinked)), "config_hardlink_denied");

    const rewriting = makeRuntimeCandidate();
    const rewritePath = join(rewriting, "bridlewise.config.json");
    const left = `${JSON.stringify(config("fixture-left"))}${" ".repeat(50_000)}\n`;
    const right = `${JSON.stringify(config("fixture-rght"))}${" ".repeat(50_000)}\n`;
    assert.equal(left.length, right.length);
    let toggle = false;
    const rewritten = await raceRuntime(rewriting, () => {
      const replacement = `${rewritePath}.replacement`;
      writeFileSync(replacement, toggle ? left : right, { mode: 0o600 });
      renameSync(replacement, rewritePath);
      toggle = !toggle;
    });
    assert.notEqual(rewritten.status, 0, "same-size replacement race unexpectedly passed");

    const substituting = makeRuntimeCandidate();
    const trace = join(substituting, "traceability");
    const alternate = join(substituting, "traceability.alternate");
    cpSync(trace, alternate, { recursive: true });
    const swapped = await raceRuntime(substituting, () => {
      const temporary = join(substituting, "traceability.swap");
      renameSync(trace, temporary);
      renameSync(alternate, trace);
      renameSync(temporary, alternate);
    });
    assert.notEqual(swapped.status, 0, "directory substitution race unexpectedly passed");
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
