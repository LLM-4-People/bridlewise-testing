/**
 * THE CANARY OF THE ONE TEST-EXECUTION DOOR (decision
 * TEST-CONFINEMENT-SELF-BIND): every runner of the web suite — `npm test`,
 * `test:raw`, `test:supported`, a CI shard, a flake reproduction — runs it
 * confined, so a write into the checkout or the user's home is refused by the
 * kernel (EROFS). A runner that ran it unconfined turns this red.
 */
import { rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CHECKOUT = join(import.meta.dirname, "..", "..");
const planted: string[] = [];
afterEach(() => { for (const path of planted.splice(0)) rmSync(path, { force: true }); });

function writeCode(folder: string): string | undefined {
  const path = join(folder, `.confinement-canary-${String(process.pid)}`);
  planted.push(path);
  try { writeFileSync(path, "escaped\n"); } catch (error) { return (error as NodeJS.ErrnoException).code; }
  return undefined;
}

describe("the one test-execution door's canary", () => {
  it("a test cannot write the checkout: the kernel refuses it (EROFS)", () => {
    expect(writeCode(CHECKOUT), "a test wrote the checkout: this runner ran it outside the one test-execution door").toBe("EROFS");
  });

  it("a test cannot write the user's home: the kernel refuses it (EROFS)", () => {
    expect(writeCode(homedir()), "a test wrote the user's home: this runner ran it outside the one test-execution door").toBe("EROFS");
  });
});
