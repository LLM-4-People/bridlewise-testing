/**
 * A PARKED PATCH STILL APPLIES (LAND-OC-FIX round 13, design: the parked
 * AMBIENT-ALLOWANCE-REMOVE patch had stopped applying by round 12 and nothing
 * said so). Every patch kept under docs/trackers/patches/ is work waiting for
 * its owner; the tree it was written against moves on every commit, so each
 * one is checked against the working tree on every run (`git apply --check`,
 * the very command its header tells the owner to run). A patch that no longer
 * applies reds here, by name, and is rebased by the commit that broke it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../support/temp-dir.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const PATCHES = join("docs", "trackers", "patches");

/** `git apply --check` of one patch file against the repository's working tree: null when it applies, else git's own words. */
function applyRefusal(patchPath: string): string | null {
  const result = spawnSync("git", ["apply", "--check", patchPath], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error !== undefined) throw result.error;
  return result.status === 0 ? null : `${result.stderr}${result.stdout}`.trim();
}

test("every parked patch under docs/trackers/patches applies to the current tree", () => {
  const directory = join(REPOSITORY_ROOT, PATCHES);
  const patches = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".patch")).sort() : [];
  const refused = patches.flatMap((name) => {
    const refusal = applyRefusal(join(PATCHES, name));
    return refusal === null ? [] : [`${PATCHES}/${name}: ${refusal}`];
  });
  assert.deepEqual(refused, [], "a parked patch no longer applies: rebase it onto the tree in the commit that moved the tree");
});

test("the check refuses a stale patch (its context no longer in the file), naming git's reason", () => {
  const scratch = createTempDir("parked-patch-");
  const stale = join(scratch, "STALE.patch");
  writeFileSync(
    stale,
    [
      "A planted parked patch whose context line is not in the file any more.",
      "",
      "diff --git a/engine/package.json b/engine/package.json",
      "--- a/engine/package.json",
      "+++ b/engine/package.json",
      "@@ -1,2 +1,2 @@",
      " {",
      '-  "this line was never in the file": true,',
      '+  "nor this one": true,',
      "",
    ].join("\n"),
  );
  const refusal = applyRefusal(stale);
  assert.notEqual(refusal, null, "a patch whose context is gone must be refused");
  assert.match(refusal ?? "", /patch does not apply|corrupt patch/u);
});
