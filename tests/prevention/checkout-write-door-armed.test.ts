// @vitest-environment node
/**
 * THE WEB SUITE ARMS THE CHECKOUT WRITE DOOR, SO NO TEST HERE REWRITES THIS CHECKOUT.
 *
 * The door (`engine/src/filesystem/checkout-write-door.ts`) no longer guesses
 * who runs tests from argv strings: our runners ARM the checkout they test.
 * For this suite the runner is vitest's main process, and the arming is the
 * root `vitest.config.ts`. A config that stopped arming would leave every
 * worker — and every generator a test spawns — free to rewrite tracked files
 * mid-run, and nothing else would say so.
 *
 * GUARD SUBJECT: every vitest worker of this suite is under test for this checkout: the inherited marker names it, and a same-bytes write of a tracked file is refused
 * GUARD OWNS: vitest.config.ts (`armCheckoutUnderTest(import.meta.dirname)` when VITEST is set)
 * GUARD PLANT: delete the arming call from vitest.config.ts; the marker is absent in the worker and the tracked write lands
 * GUARD DRIVEN: the worker's protected set and marker, a refused atomicWriteFile of a tracked file, and a child spawned with a scrubbed env that is refused through the held marker
 * GUARD LIVENESS: the target is asserted byte-identical after each probe, and a write to this suite's own state directory is asserted to be allowed
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertCheckoutWriteAllowed,
  CHECKOUT_WRITE_REFUSAL_CODE,
  protectedCheckoutsOfThisProcess,
} from "../../engine/src/filesystem/checkout-write-door.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";

const ROOT = realpathSync(join(import.meta.dirname, "..", ".."));
const TRACKED = join(ROOT, "package.json");
const MARKER = ROOT_POLICY.verification.checkoutWriteDoor.markerEnvironmentVariable;

describe("the web suite arms the checkout write door", () => {
  test("this worker inherits the marker and protects this checkout", () => {
    expect(JSON.parse(process.env[MARKER] ?? "[]")).toContain(ROOT);
    expect(protectedCheckoutsOfThisProcess().map((entry) => entry.path)).toContain(ROOT);
  });

  test("a tracked file is refused in-process, and the state directory stays writable", () => {
    const before = readFileSync(TRACKED);
    expect(() => atomicWriteFile(TRACKED, before)).toThrow(expect.objectContaining({ code: CHECKOUT_WRITE_REFUSAL_CODE }));
    expect(readFileSync(TRACKED).equals(before)).toBe(true);
    expect(() => assertCheckoutWriteAllowed(join(ROOT, ".bridlewise", "state", "probe.json"))).not.toThrow();
  });

  test("a child with a scrubbed env is refused through the marker this worker holds", () => {
    const before = readFileSync(TRACKED);
    const writer = pathToFileURL(join(ROOT, "engine", "src", "filesystem", "atomic-write.ts")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `const { atomicWriteFile } = await import(${JSON.stringify(writer)});`,
      "const { readFileSync } = await import('node:fs');",
      `try { atomicWriteFile(${JSON.stringify(TRACKED)}, readFileSync(${JSON.stringify(TRACKED)})); process.stdout.write('WROTE'); }`,
      "catch (error) { process.stdout.write(String(error.code)); }",
    ].join("\n")], { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(result.stdout, result.stderr).toBe(CHECKOUT_WRITE_REFUSAL_CODE);
    expect(readFileSync(TRACKED).equals(before)).toBe(true);
  });
});
