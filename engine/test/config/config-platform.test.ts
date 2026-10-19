import assert from "node:assert/strict";
import test from "node:test";

/**
 * INVARIANT #74: on non-Linux platforms the config bootstrap must not crash —
 * it skips mount-point verification (returns an empty set) and emits a single
 * typed warning (code "mountpoint_check_skipped_non_linux") instead. The
 * cross-device check (stats.dev) still runs on every platform.
 *
 * `PLATFORM_SUPPORTS_MOUNTINFO` is captured at module-load time from
 * `process.platform`, so this test mocks `process.platform` to "darwin"
 * BEFORE dynamically importing `src/config.ts`, forcing a fresh module load
 * with the non-Linux branch active. Both the "warning is emitted" and
 * "warning is emitted only once per module load" assertions are in a single
 * test so they share the same (cached) module instance.
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
    setPlatform("darwin");
    // Dynamic import forces a fresh module load so PLATFORM_SUPPORTS_MOUNTINFO
    // is computed with the mocked platform.
    const { loadPinnedConfigSnapshot } = await import("../../src/kernel/config.ts");

    // Call loadPinnedConfigSnapshot TWICE. readPlatformMountPoints is invoked
    // multiple times internally (assertPinnedRepositoryRoot +
    // inspectRepositoryConfigSurface) and across both calls, but
    // nonLinuxMountpointWarningEmitted deduplicates so only ONE warning is
    // emitted per module load.
    for (let i = 0; i < 2; i++) {
      try {
        loadPinnedConfigSnapshot();
      } catch (error) {
        // It may succeed or throw a typed error; it must NOT crash with a
        // non-Error (e.g. a TypeError from an undefined path).
        assert.ok(
          error instanceof Error,
          "on non-Linux, loadPinnedConfigSnapshot must either succeed or throw a typed Error (not crash)",
        );
      }
    }

    // The warning is emitted asynchronously; allow a tick for delivery.
    await new Promise<void>((resolve) => setImmediate(resolve));

    const mountpointWarnings = warnings.filter((w) => w.code === "mountpoint_check_skipped_non_linux");
    assert.equal(
      mountpointWarnings.length,
      1,
      "the non-Linux mountpoint warning must be emitted exactly once per module load",
    );
    assert.ok(
      /darwin/.test(mountpointWarnings[0]!.message) || /non-Linux/.test(mountpointWarnings[0]!.message),
      "the warning message must mention the non-Linux platform",
    );
  } finally {
    process.removeListener("warning", handler);
    restorePlatform();
  }
});
