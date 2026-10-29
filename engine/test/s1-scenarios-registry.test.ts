import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { discoverTestNames } from "../scripts/test-inventory.ts";
import { REPOSITORY_ROOT, registeredScenarios } from "./support/s1-scenario-shared.ts";

const FAMILY_FILE_PATTERN = /^b\d{2}\.test\.ts$/u;
// A scenario that needs a real host fact the confined hermetic run cannot have (a supplementary group an
// unprivileged user namespace cannot map) lives in the LIVE suite, one file each: `live/s1-<family>-<variant>.test.ts`
// (decision TEST-CONFINEMENT-SELF-BIND). It is still part of the one registry.
const LIVE_FAMILY_FILE_PATTERN = /^s1-(b\d{2})-[a-z-]+\.test\.ts$/u;

test("s1 scenario registry is closed-world complete across per-family files", () => {
  const directory = join(REPOSITORY_ROOT, "test", "s1-scenarios");
  const files = readdirSync(directory).filter((entry) => FAMILY_FILE_PATTERN.test(entry)).toSorted();
  assert.ok(files.length > 0, "no s1 scenario family files discovered");
  const liveDirectory = join(REPOSITORY_ROOT, "live");
  const liveFiles = readdirSync(liveDirectory).filter((entry) => LIVE_FAMILY_FILE_PATTERN.test(entry)).toSorted();
  const discovered: string[] = [];
  for (const [folder, file, family] of [
    ...files.map((file) => [directory, file, file.replace(".test.ts", "")] as const),
    ...liveFiles.map((file) => [liveDirectory, file, LIVE_FAMILY_FILE_PATTERN.exec(file)![1]!] as const),
  ]) {
    const names = discoverTestNames(readFileSync(join(folder, file), "utf8"));
    const familyPrefix = `S1-${family.toUpperCase()}-`;
    for (const name of names) {
      assert.ok(name.startsWith(familyPrefix), `${file} registers out-of-family scenario ${name}`);
    }
    discovered.push(...names);
  }
  assert.equal(new Set(discovered).size, discovered.length, "duplicate scenario ids across family files");
  assert.deepEqual(discovered.toSorted(), registeredScenarios());
});
