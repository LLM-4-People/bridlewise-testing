import assert from "node:assert/strict";
import test from "node:test";

/**
 * INVARIANT #74: on non-Linux platforms the config bootstrap must not crash —
 * it skips mount-point verification (returns an empty set) and emits a typed
 * warning (code "mountpoint_check_skipped_non_linux") instead. The
 * cross-device check (stats.dev) still runs on every platform.
 *
 * The platform is read at each call and the warning is said once per process
 * FOR EACH PLATFORM (src/kernel/config.ts `warnedPlatforms`). The test used to
 * rely on a "fresh" dynamic import, which answers the cached module whenever
 * an earlier test file in the same process loaded the configuration first
 * (on Linux, so the faked darwin warned nothing: FLAKY-CONFIG-PLATFORM-WARN-ONCE).
 */

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true, writable: true });
}

function restorePlatform(): void {
  setPlatform(ORIGINAL_PLATFORM);
}

test("ConfigPlatform: non-Linux bootstrap emits a single typed mountpoint-skip warning", async () => {
  const warnings: Array<{ code: string | undefined; message: string }> = [];
  const handler = (warning: Error & { code?: string; type?: string }) => {
    warnings.push({ code: warning.code, message: warning.message });
  };
  process.on("warning", handler);
  try {
    // The module is loaded on Linux first (as an earlier test file in this process may load it): the platform is read per call.
    const { loadPinnedConfigSnapshot } = await import("../../src/kernel/config.ts");
    const bootstraps = async (platform: string, times: number): Promise<readonly string[]> => {
      setPlatform(platform);
      for (let i = 0; i < times; i++) {
        try {
          loadPinnedConfigSnapshot();
        } catch (error) {
          // It may succeed or throw a typed error; it must NOT crash with a non-Error.
          assert.ok(error instanceof Error, "on non-Linux, loadPinnedConfigSnapshot must either succeed or throw a typed Error (not crash)");
        }
      }
      // The warning is emitted asynchronously; allow a tick for delivery.
      await new Promise<void>((resolve) => setImmediate(resolve));
      return warnings.filter((w) => w.code === "mountpoint_check_skipped_non_linux").map((w) => w.message);
    };
    // Several darwin bootstraps (loadPinnedConfigSnapshot is not cached) after the Linux load: exactly one warning.
    const darwin = await bootstraps("darwin", 3);
    assert.equal(darwin.length, 1, "repeated darwin bootstraps warn once in the process");
    assert.ok(/darwin/.test(darwin[0]!), "the warning names the platform it skipped on");
    // Another non-Linux platform is another warning, once.
    const win32 = await bootstraps("win32", 2);
    assert.equal(win32.length, 2, "each non-Linux platform warns once");
    assert.ok(/win32/.test(win32[1]!));
  } finally {
    process.removeListener("warning", handler);
    restorePlatform();
  }
});
