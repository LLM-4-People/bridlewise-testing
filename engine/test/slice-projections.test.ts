import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("stage-6 slice projections pass all sixteen hostile families in three fresh processes", () => {
  const worker = resolve("test/support/slice-projection-hostile-worker.ts");
  const environments = [
    { TZ: "UTC", LANG: "C" },
    { TZ: "America/Toronto", LANG: "C.UTF-8" },
    { TZ: "Asia/Tokyo", LANG: "en_US.UTF-8" },
  ];
  const reports = environments.map((environment) => {
    const result = spawnSync(process.execPath, [worker], {
      cwd: resolve("."),
      encoding: "utf8",
      env: { ...process.env, ...environment },
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout) as Readonly<{
      families: readonly string[];
      buildIdentity: string;
      artifactHashes: Readonly<Record<string, string>>;
    }>;
  });
  assert.equal(reports[0]!.families.length, 16);
  assert.deepEqual(reports[0], reports[1]);
  assert.deepEqual(reports[1], reports[2]);
});
