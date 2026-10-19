import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { discoverTestNames } from "../scripts/test-inventory.ts";
import { REPOSITORY_ROOT, registeredScenarios } from "./support/s1-scenario-shared.ts";

const FAMILY_FILE_PATTERN = /^b\d{2}\.test\.ts$/u;

test("s1 scenario registry is closed-world complete across per-family files", () => {
  const directory = join(REPOSITORY_ROOT, "test", "s1-scenarios");
  const files = readdirSync(directory).filter((entry) => FAMILY_FILE_PATTERN.test(entry)).toSorted();
  assert.ok(files.length > 0, "no s1 scenario family files discovered");
  const discovered: string[] = [];
  for (const file of files) {
    const names = discoverTestNames(readFileSync(join(directory, file), "utf8"));
    const familyPrefix = `S1-${file.replace(".test.ts", "").toUpperCase()}-`;
    for (const name of names) {
      assert.ok(name.startsWith(familyPrefix), `${file} registers out-of-family scenario ${name}`);
    }
    discovered.push(...names);
  }
  assert.equal(new Set(discovered).size, discovered.length, "duplicate scenario ids across family files");
  assert.deepEqual(discovered.toSorted(), registeredScenarios());
});
