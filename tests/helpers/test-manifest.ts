// @vitest-environment node
/**
 * THE SHARD MANIFEST, READ ONCE — the owner of the two populations a test run
 * can judge.
 *
 * `tests/test-shards.json` declares every live test file as either SUPPORTED
 * (a full run covers it) or EXCLUDED (with the reason it cannot be judged in
 * this snapshot: private artifacts, a WSL host, a generated profile). Two
 * consumers need those facts — the budget's population count and the flaky
 * memory guard — so both read them here instead of parsing the JSON again.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const TEST_MANIFEST_PATH = resolve(import.meta.dirname, "..", "test-shards.json");

type TestManifest = Readonly<{
  files: readonly Readonly<{ path: string }>[];
  excluded: readonly Readonly<{ path: string; reason: string }>[];
}>;

function readManifest(): TestManifest {
  const parsed = JSON.parse(readFileSync(TEST_MANIFEST_PATH, "utf8")) as Partial<TestManifest>;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("tests/test-shards.json declares no supported files");
  }
  if (!Array.isArray(parsed.excluded)) throw new Error("tests/test-shards.json has no excluded array");
  return parsed as TestManifest;
}

/** Every file a full run judges. */
export function supportedTestFiles(): readonly string[] {
  return readManifest().files.map((file) => file.path);
}

/** Every declared exclusion, keyed by path, with the reason it cannot be judged here. */
export function excludedTestFiles(): ReadonlyMap<string, string> {
  return new Map(readManifest().excluded.map((file) => [file.path, file.reason]));
}
