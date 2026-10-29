/**
 * THE CANARY OF THE ONE TEST-EXECUTION DOOR (decision
 * TEST-CONFINEMENT-SELF-BIND): every runner that runs this suite — the engine
 * runner, the guard runner, coverage, a flake reproduction — runs it confined,
 * so a write into the checkout or the user's home is refused by the kernel
 * (EROFS). A runner that ran it unconfined turns this red: confinement is
 * never opt-in per caller.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const CHECKOUT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: new URL(".", import.meta.url), encoding: "utf8" }).trim();

function refusedByTheKernel(folder: string, t: { after: (fn: () => void) => void }): void {
  const planted = join(folder, `.confinement-canary-${String(process.pid)}`);
  t.after(() => rmSync(planted, { force: true }));
  assert.throws(() => writeFileSync(planted, "escaped\n"), (error: unknown) => (error as NodeJS.ErrnoException).code === "EROFS",
    `a test wrote ${planted}: this runner ran it outside the one test-execution door`);
}

test("a test cannot write the checkout: the kernel refuses it (EROFS)", (t) => {
  refusedByTheKernel(CHECKOUT, t);
});

test("a test cannot write the user's home: the kernel refuses it (EROFS)", (t) => {
  refusedByTheKernel(homedir(), t);
});
