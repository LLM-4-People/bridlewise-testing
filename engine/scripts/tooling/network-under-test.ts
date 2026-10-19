/**
 * A TEST RUN DIALS NOTHING BUT THIS MACHINE — how the runners load the guard.
 *
 * The socket guard (`network-under-test-guard.mjs`: `net.Socket.prototype.connect`,
 * the one method every TCP client of the platform connects through) is loaded
 * into every process that RUNS TESTS (wf-del2-correctness NEW-5: a raw `fetch`
 * from a test process reached example.com; the outbound door only refuses what
 * is sent through it):
 *
 *   - the engine: the test worker loads it into itself
 *     ({@link refuseRemoteNetworkUnderTest}; in-process phases), and every test
 *     file's own process is started with it preloaded
 *     (`inventory-test-run.ts` hands node:test {@link networkGuardImport});
 *   - the web suite: the setup file every test file runs first
 *     (`tests/setup/test-setup.ts`) loads it into the worker.
 *
 * NOT through `NODE_OPTIONS` to every descendant: a process a test starts
 * under the guardian's confinement cannot read the harness tree, so a
 * preload naming a harness file kept every confined node payload from
 * starting (measured: the self-protection e2e probe exited 1). A process a
 * test spawns itself is the test's own business; the door still refuses what
 * it sends through the harness.
 *
 * The run's one declared opt-in (`src/process/live-network.ts`) is read here,
 * where the root policy is loaded anyway, and handed to the guard's installer,
 * so the guard itself stays on node built-ins.
 */

import { liveHostsUnderTest } from "../../src/process/live-network.ts";
import { installNetworkGuard } from "./network-under-test-guard.mjs";

/** The guard module as a file URL, for the preload of a process the run starts itself. */
const GUARD = new URL("./network-under-test-guard.mjs", import.meta.url).href;

/**
 * The node option that preloads the guard into a process the run starts to
 * run test files: a `data:` module that installs it with `liveHosts` (the
 * run's consented live hosts by default).
 */
export function networkGuardImport(liveHosts: readonly string[] = liveHostsUnderTest()): string {
  const install = `import { installNetworkGuard } from ${JSON.stringify(GUARD)}; installNetworkGuard(${JSON.stringify(liveHosts)});`;
  return `--import=data:text/javascript,${encodeURIComponent(install)}`;
}

/**
 * Guards THIS process (idempotent: the first guard a process installs is the
 * one it keeps). A static import, so it resolves in every test environment
 * (a vitest DOM file's module URLs are not file URLs).
 */
export function refuseRemoteNetworkUnderTest(): void {
  installNetworkGuard(liveHostsUnderTest());
}
