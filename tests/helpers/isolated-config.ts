/**
 * Test-owned harness config selection, with exact original-file custody checks:
 * a test's own harness config lives in a temp folder, and the live checkout's
 * config and harness folder are never written.
 *
 * Two shapes. `isolateHarnessConfig` copies the live config for the server
 * under test. `harnessViewConfig` writes a test's own config into a HARNESS
 * VIEW (`harnessView`), for a runner that derives the harness root (and so the
 * guardian it searches for) from the config's path: a temp folder whose every
 * entry but the config and the STATE FOLDER is a link to the real harness's
 * entry. The view's state folder is its own: a link would let the runner make
 * its MCP homes and confined scratch folders inside the LIVE harness
 * (measured by the correctness re-verification). A config written INTO the
 * live `engine/` folder was the old way, and it is a defect, measured
 * (2026-10-10): creating and removing a file there changes the folder's
 * identity, and every concurrent reader of the real config, which verifies its
 * parent folder's identity before trusting the file (engine/src/kernel/config.ts,
 * `config_parent_changed`), failed ("THE GATE COULD NOT RUN: Configuration
 * parent identity changed": the web budget reporter's drives lost their
 * history rows).
 */
import { afterAll, expect } from "vitest";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { STATE_DIRECTORY_NAME } from "../../engine/src/kernel/product-identity.ts";
import { resetServerConfig, serverConfig } from "../../server/kernel/config.ts";
import { refreshSettingsSnapshot } from "../../server/kernel/harness-config.ts";
import { writeFileWithFreshMtime } from "./fresh-mtime.ts";
import { createTempDir } from "./temp-dir.ts";

export function isolateHarnessConfig(prefix: string): string {
  const source = resolve(serverConfig.harnessConfigPath);
  const bytes = readFileSync(source);
  const before = statSync(source, { bigint: true });
  const path = join(createTempDir(prefix), "bridlewise.config.json");
  copyFileSync(source, path);
  process.env["HARNESS_CONFIG_PATH"] = path;
  resetServerConfig();
  afterAll(() => {
    const after = statSync(source, { bigint: true });
    expect(readFileSync(source), "config tests must leave their source bytes untouched").toEqual(bytes);
    expect([after.mode, after.mtimeNs, after.ino], "config tests must leave their source metadata untouched")
      .toEqual([before.mode, before.mtimeNs, before.ino]);
  });
  return path;
}

/**
 * Plant a settings document the way an operator's hand edit reaches a running
 * server: the exact bytes land on disk (0600, atomically, bypassing the write
 * gate — a planted section the gate would refuse is the point of many arms),
 * then the refresh every request start performs. The config owner never
 * reads the file per call, so a test that only wrote the file would keep
 * reading the previous snapshot.
 */
export function plantSettingsDocument(path: string, text: string): void {
  writeFileWithFreshMtime(path, text, { mode: 0o600 });
  refreshSettingsSnapshot();
}

/** The real harness root (the checkout's `engine/`). */
export function realHarnessRoot(): string {
  return fileURLToPath(new URL("../../engine", import.meta.url));
}

/** A harness view (removed with the test's temp folders): the real harness's entries linked, its own state folder, no config yet. */
export function harnessView(prefix: string): string {
  const view = createTempDir(prefix);
  for (const entry of readdirSync(realHarnessRoot())) {
    if (entry !== "bridlewise.config.json" && entry !== STATE_DIRECTORY_NAME) symlinkSync(join(realHarnessRoot(), entry), join(view, entry));
  }
  mkdirSync(join(view, STATE_DIRECTORY_NAME), { mode: 0o700 });
  return view;
}

/** Writes `config` as the harness view's `bridlewise.config.json` and answers its path. */
export function harnessViewConfig(view: string, config: unknown): string {
  const path = join(view, "bridlewise.config.json");
  const written = atomicWriteFile(path, JSON.stringify(config), { createMode: 0o600 });
  if (!written.success) throw new Error(`the harness view's config could not be written: ${written.reason ?? "unknown"}`);
  return path;
}
