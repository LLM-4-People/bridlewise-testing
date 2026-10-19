/**
 * The socket guard's one export (`network-under-test-guard.mjs`, plain
 * JavaScript so it can be preloaded cheaply): guards this process — from now
 * on it connects only to this machine and to `liveHosts` (exact names).
 * Idempotent per process.
 */
export declare function installNetworkGuard(liveHosts: readonly string[]): void;
