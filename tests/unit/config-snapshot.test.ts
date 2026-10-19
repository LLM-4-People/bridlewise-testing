// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  configSnapshot,
  isConfigLoaded,
  setConfig,
  resetConfig,
} from "../../src/state/config-snapshot";
import type { ConfigSnapshot } from "../../shared/types";

const SNAPSHOT: ConfigSnapshot = {
  document: {
    schemaVersion: "1",
    entries: {},
    parentEntriesHash: "0",
  } as unknown as ConfigSnapshot["document"],
  canonicalHash: "h1",
  sourceHash: "s1",
  source: {
    kind: "file",
    path: "/cfg",
    hash: "s1",
  } as unknown as ConfigSnapshot["source"],
  repositoryRoot: "/repo",
  projectRoot: "/project",
  repositoryManifestHash: "m1",
};

describe("config-snapshot store", () => {
  beforeEach(() => resetConfig());

  test("initial state is null and not loaded", () => {
    expect(configSnapshot.get()).toBeNull();
    expect(isConfigLoaded.get()).toBe(false);
  });

  test("setConfig stores the snapshot and marks loaded", () => {
    setConfig(SNAPSHOT);
    expect(configSnapshot.get()).not.toBeNull();
    expect(isConfigLoaded.get()).toBe(true);
    expect(configSnapshot.get()?.projectRoot).toBe("/project");
  });

  test("resetConfig clears the snapshot", () => {
    setConfig(SNAPSHOT);
    resetConfig();
    expect(configSnapshot.get()).toBeNull();
    expect(isConfigLoaded.get()).toBe(false);
  });
});
