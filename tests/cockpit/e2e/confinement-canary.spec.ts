/**
 * THE CANARY OF THE ONE TEST-EXECUTION DOOR for the browser runs (decision
 * TEST-CONFINEMENT-SELF-BIND): `test:e2e` and `test:all` run Playwright
 * confined, so a write into the checkout is refused by the kernel (EROFS).
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

test("a browser-run test cannot write the checkout: the kernel refuses it (EROFS)", () => {
  const path = join(import.meta.dirname, "..", "..", "..", `.confinement-canary-${String(process.pid)}`);
  let code: string | undefined;
  try { writeFileSync(path, "escaped\n"); } catch (error) { code = (error as NodeJS.ErrnoException).code; } finally { rmSync(path, { force: true }); }
  expect(code, `a test wrote ${path}: Playwright ran outside the one test-execution door`).toBe("EROFS");
});
