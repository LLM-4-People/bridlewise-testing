// Prevention test for the shared subprocess mock helper.
// Verifies the mock intercepts calls, returns canned results, restores
// properly, and falls through to the real subprocess when the handler
// returns undefined.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subprocess, installSubprocessMock } from "../support/subprocess-mock.ts";

test("subprocess mock: spawnSync returns canned result when handler matches", () => {
  const restore = installSubprocessMock(() => ({ status: 42, stdout: "mocked-out", stderr: "" }));
  try {
    const result = subprocess.spawnSync("git", ["status"], { encoding: "utf8" });
    assert.equal(result.status, 42);
    assert.equal(result.stdout, "mocked-out");
  } finally {
    restore();
  }
});

test("subprocess mock: spawnSync falls through to real when handler returns undefined", () => {
  const restore = installSubprocessMock(() => undefined);
  try {
    const result = subprocess.spawnSync("node", ["-e", "process.exit(0)"], { encoding: "utf8" });
    assert.equal(result.status, 0);
  } finally {
    restore();
  }
});

test("subprocess mock: execSync returns canned stdout", () => {
  const restore = installSubprocessMock(() => ({ status: 0, stdout: "canned", stderr: "" }));
  try {
    const out = subprocess.execSync("git rev-parse HEAD");
    assert.equal(out, "canned");
  } finally {
    restore();
  }
});

test("subprocess mock: restore reverts to real subprocess", () => {
  const restore = installSubprocessMock(() => ({ status: 99, stdout: "", stderr: "" }));
  restore();
  const result = subprocess.spawnSync("node", ["-e", "process.exit(0)"], { encoding: "utf8" });
  assert.equal(result.status, 0);
});

test("subprocess mock: handler receives command + args", () => {
  const observed: { command: string; args: readonly string[] }[] = [];
  const restore = installSubprocessMock((command, args) => {
    observed.push({ command, args });
    return { status: 0, stdout: "", stderr: "" };
  });
  try {
    subprocess.spawnSync("git", ["log", "--oneline"], { encoding: "utf8" });
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.command, "git");
    assert.deepEqual([...observed[0]!.args], ["log", "--oneline"]);
  } finally {
    restore();
  }
});

test("subprocess mock: nested install/restore preserves previous handler", () => {
  const outer = installSubprocessMock(() => ({ status: 1, stdout: "outer", stderr: "" }));
  const inner = installSubprocessMock(() => ({ status: 2, stdout: "inner", stderr: "" }));
  try {
    const r1 = subprocess.spawnSync("any", [], { encoding: "utf8" });
    assert.equal(r1.status, 2);
    assert.equal(r1.stdout, "inner");
    inner();
    const r2 = subprocess.spawnSync("any", [], { encoding: "utf8" });
    assert.equal(r2.status, 1);
    assert.equal(r2.stdout, "outer");
  } finally {
    outer();
  }
});
