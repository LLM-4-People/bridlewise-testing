import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readLinuxMountPoints } from "../../src/filesystem/linux-path.ts";
import { decideFilesystemBoundary } from "../../src/filesystem/path-boundary.ts";
import { createPreflightContext } from "../../src/kernel/preflight.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, importCandidatePreflight, REPOSITORY_ROOT } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B04-CONTROL": () => {
    const context = createPreflightContext();
    const root = context.inspectPath(".");
    assert.equal(root.decision, "allow");
    assert.equal(root.code, "path_descriptor_verified_provisional");
    assert.equal(root.provisional, true);
    assert.equal(root.effectAuthorized, false);
    const configDecision = context.inspectPath("bridlewise.config.json");
    assert.equal(configDecision.decision, "allow");
    assert.equal(configDecision.canonicalPath, join(REPOSITORY_ROOT, "bridlewise.config.json"));
  },
  "S1-B04-FAILURE": async () => {
    const context = createPreflightContext();
    assert.equal(context.inspectPath("a/../outside").code, "path_traversal_denied");
    assert.equal(context.inspectPath("../outside").code, "path_traversal_denied");
    assert.equal(context.inspectPath("/tmp/outside").code, "path_invalid");
    assert.equal(context.inspectPath("").code, "path_invalid");

    const root = makeRuntimeCandidate();
    writeFileSync(join(root, "aliased.txt"), "same\n");
    linkSync(join(root, "aliased.txt"), join(root, "aliased-again.txt"));
    const candidate = await importCandidatePreflight(root);
    assert.equal(candidate.createPreflightContext().inspectPath("aliased.txt").code, "path_hardlink_denied");
  },
  "S1-B04-HOSTILE-REAL": async () => {
    assert.equal(decideFilesystemBoundary(1n, 2n, false), "path_cross_device_denied");
    assert.equal(decideFilesystemBoundary(1n, 1n, true), "path_mountpoint_denied");
    assert.equal(decideFilesystemBoundary(1n, 1n, false), undefined);

    const mounted = makeRuntimeCandidate();
    for (const name of ["source", "bind", "cross"]) mkdirSync(join(mounted, "scratch", name), { recursive: true });
    const mountProbe = spawnSync("unshare", [
      "--user", "--map-root-user", "--mount", "--fork",
      process.execPath, join(mounted, "test", "support", "path-boundary-probe.ts"), mounted,
    ], { cwd: mounted, encoding: "utf8" });
    assert.equal(mountProbe.status, 0, `mount namespace capability unavailable: ${mountProbe.stderr}`);
    const mountEvidence = JSON.parse(mountProbe.stdout) as {
      capability: string;
      bind: { code: string };
      crossDevice: { code: string };
    };
    assert.equal(mountEvidence.capability, "available");
    assert.equal(mountEvidence.bind.code, "path_mountpoint_denied");
    assert.equal(mountEvidence.crossDevice.code, "path_cross_device_denied");

    const root = makeRuntimeCandidate();
    mkdirSync(join(root, "scratch"));
    const candidate = await importCandidatePreflight(root);
    const context = candidate.createPreflightContext();
    symlinkSync("/proc", join(root, "scratch", "mounted-alias"));
    assert.equal(context.inspectPath("scratch/mounted-alias").code, "path_symlink_denied");
    assert.equal(readLinuxMountPoints().has("/proc"), true);

    const displacedRoot = `${root}.displaced`;
    renameSync(root, displacedRoot);
    mkdirSync(root, { mode: 0o700 });
    try {
      assert.equal(context.inspectPath(".").code, "root_identity_changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
      renameSync(displacedRoot, root);
    }

    // Test root_identity_changed via mode mutation on a candidate, not the
    // live repo. This verifies the same invariant (preflight detects a mode
    // change on the project root) without mutating the shared repository
    // filesystem, making the scenario safe for concurrent serial-phase
    // execution.
    const modeRoot = makeRuntimeCandidate();
    const modeCandidate = await importCandidatePreflight(modeRoot);
    const modeContext = modeCandidate.createPreflightContext();
    const mode = Number.parseInt(modeContext.receipt.project.mode, 8);
    chmodSync(modeRoot, mode ^ 0o100);
    try {
      assert.equal(modeContext.inspectPath(".").code, "root_identity_changed");
    } finally {
      chmodSync(modeRoot, mode);
    }
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
