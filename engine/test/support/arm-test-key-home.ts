/**
 * The test runs' key-home preload (`node --import`): arms the run's private
 * key home ({@link armTestKeyHome}) in the `node --test` process, inside its
 * confinement, before any test file starts; each file's process inherits it.
 * The guard runner (scripts/tooling/test-guards.ts) passes it.
 */
import { armTestKeyHome } from "./test-key-home.ts";

armTestKeyHome();
