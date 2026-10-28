/**
 * THE ONE BOUNDED SYNCHRONOUS RUN (src/process/subprocess-bounds.ts
 * `spawnBoundedSync`): the command runs under the CPU limit, the hang
 * backstop is its only wall bound, and a caller cannot put a wall timeout of
 * its own on it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { boundedEnding, spawnBoundedSync } from "../../src/process/subprocess-bounds.ts";

const BOUNDS = Object.freeze({ cpuLimitSeconds: 7, cpuKillGraceSeconds: 1, hangBackstopMs: 60_000 });

test("spawnBoundedSync: the command runs under the CPU limit (soft, and hard a grace above it)", () => {
  const run = spawnBoundedSync("/bin/sh", ["-c", 'printf "%s:%s" "$(ulimit -S -t)" "$(ulimit -H -t)"'], BOUNDS, { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "7:8");
});

test("spawnBoundedSync: a caller's own wall timeout is not applied (the bounds set the only one)", () => {
  // The options type has no timeout; one forced through is overridden by the hang backstop.
  const run = spawnBoundedSync("/bin/sh", ["-c", "sleep 0.2"], BOUNDS, { encoding: "utf8", timeout: 1 } as never);
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0);
});

test("spawnBoundedSync: the hang backstop ends a run that is still going, and the ending says it hung", () => {
  const bounds = { ...BOUNDS, hangBackstopMs: 200 };
  const run = spawnBoundedSync("/bin/sh", ["-c", "exec sleep 30"], bounds, { encoding: "utf8" });
  const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
  assert.equal(code, "ETIMEDOUT");
  assert.match(boundedEnding({ status: run.status, signal: run.signal, ...(code === undefined ? {} : { errorCode: code }) }, bounds), /^HUNG: .* hang backstop/u);
});
