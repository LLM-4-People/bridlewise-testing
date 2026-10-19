/**
 * A HOST REQUIREMENT, said by name (LIVE-SUITE; UR-20). A hermetic test that
 * needs something of the machine it runs on — Linux (the guardian is
 * Landlock), the built guardian binary, a user systemd, a fixture the checkout
 * setup links in — ASSERTS it. A missing one is a red that names what the test
 * host lacks, never a test that returns green having checked nothing
 * (engine/test/prevention/hermetic-suites-have-no-skips.test.ts finds the
 * silent shape).
 */
import assert from "node:assert/strict";

/** Fail, naming the requirement, unless `met`. */
export function requireHost(met: boolean, requirement: string): asserts met {
  assert.ok(met, `HOST REQUIREMENT not met: ${requirement}. The test host must provide it; a hermetic test never skips on its absence.`);
}

/** The test host runs Linux (Landlock, procfs, the guardian). */
export function requireLinuxHost(): void {
  requireHost(process.platform === "linux", `Linux (this host is ${process.platform})`);
}
