/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision) for FLAKY-CONFIG-PLATFORM-WARN-ONCE: the configuration module
 * (src/kernel/config.ts) loaded in the test process BEFORE the test runs, as
 * any earlier test file in the same process loads it. It recreates,
 * deterministically, the order CI hit by chance: the test's "fresh" dynamic
 * import then answers the cached module, whose platform and warn-once state
 * were fixed at that first load. Nothing else is touched.
 *
 * Preloaded into the reproduction run's node test process (the door's
 * --import); never imported by a test. The door pins THIS repository's shim
 * bytes for both revisions, while setting cwd to each candidate's engine.
 * Resolve the config from that cwd, so the same shim primes the candidate
 * rather than the caller. No query suffix: the test must see the same module.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

await import(pathToFileURL(resolve(process.cwd(), "src/kernel/config.ts")).href);
