import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { SAFE_READ_REJECT_ENV_VARS } from "../../src/shared/source-scan.ts";
import { applyDevModeSafeReadEnvVars, isDevMode } from "../../src/shared/dev-mode-env.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** The per-test scenario config, planted through the atomic-rename owner —
 *  the same owner every other config write in the walked population uses, so
 *  no raw truncating write to a config-shaped path survives the census. */
function writeScenarioConfig(tmp: string, body: string): void {
  const result = atomicWriteFile(join(tmp, "bridlewise.config.json"), body);
  assert.ok(result.success, result.reason);
}

test("dev-mode-env: isDevMode returns false when the config is missing", () => {
  const tmp = createTempDir("devmode-missing-");
  try {
    assert.equal(isDevMode(tmp), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dev-mode-env: isDevMode returns true when selfProtection.enabled is false", () => {
  const tmp = createTempDir("devmode-off-");
  try {
    writeScenarioConfig(tmp, JSON.stringify({ selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false } }));
    assert.equal(isDevMode(tmp), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dev-mode-env: a config WITHOUT a selfProtection section is not dev mode — absence is confined, one owner with the web server", () => {
  const tmp = createTempDir("devmode-absent-");
  try {
    writeScenarioConfig(tmp, JSON.stringify({ tools: {} }));
    assert.equal(isDevMode(tmp), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dev-mode-env: isDevMode returns false when selfProtection.enabled is true (production floor)", () => {
  const tmp = createTempDir("devmode-on-");
  try {
    writeScenarioConfig(tmp, JSON.stringify({ selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true } }));
    assert.equal(isDevMode(tmp), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dev-mode-env: isDevMode REFUSES an unparseable config with the reader's typed code (never a guessed mode)", () => {
  const tmp = createTempDir("devmode-broken-");
  try {
    writeScenarioConfig(tmp, "{ not valid json");
    assert.throws(() => isDevMode(tmp), (error: unknown) => (error as { code?: string }).code === "config_json_invalid");
    writeScenarioConfig(tmp, "[]");
    assert.throws(() => isDevMode(tmp), (error: unknown) => (error as { code?: string }).code === "config_document_not_object");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dev-mode-env: applyDevModeSafeReadEnvVars sets both env vars to 0 in dev mode when unset", () => {
  const tmp = createTempDir("devmode-apply-");
  try {
    writeScenarioConfig(tmp, JSON.stringify({ selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false } }));
    const savedH = process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
    const savedS = process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
    delete process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
    delete process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
    try {
      const result = applyDevModeSafeReadEnvVars(tmp);
      assert.equal(result.devMode, true);
      assert.equal(result.hardlinks, "0");
      assert.equal(result.symlinks, "0");
      assert.equal(process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks], "0");
      assert.equal(process.env[SAFE_READ_REJECT_ENV_VARS.symlinks], "0");
    } finally {
      if (savedH === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
      else process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = savedH;
      if (savedS === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
      else process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = savedS;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("dev-mode-env: applyDevModeSafeReadEnvVars preserves an explicit =1 (never overrides the operator's production floor)", () => {
  const tmp = createTempDir("devmode-keep-1-");
  try {
    writeScenarioConfig(tmp, JSON.stringify({ selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false } }));
    const savedH = process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
    const savedS = process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
    process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = "1";
    process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = "1";
    try {
      const result = applyDevModeSafeReadEnvVars(tmp);
      assert.equal(result.devMode, true);
      assert.equal(result.hardlinks, "1", "an explicit production floor must be preserved, not overridden to 0");
      assert.equal(result.symlinks, "1", "an explicit production floor must be preserved, not overridden to 0");
    } finally {
      if (savedH === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
      else process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = savedH;
      if (savedS === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
      else process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = savedS;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
