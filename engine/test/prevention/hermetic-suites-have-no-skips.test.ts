/**
 * THE HERMETIC SUITES HAVE NO SKIPS (UR-20, UR-24; LAND-OC-FIX LIVE-INTEROP,
 * E19).
 *
 * A hermetic run measures the checkout and nothing else, so nothing in it may
 * decide at run time, from the machine it happens to run on, not to run: a
 * skip is a test that did not pass, and an environment-conditional one is a
 * different suite on every host. What depends on the world outside the
 * checkout lives in the ONE live suite (`npm run test:live`, engine/live/),
 * which refuses loudly without its consent; a capability a hermetic test needs
 * is asserted by name (engine/test/support/host-requirement.ts), never skipped
 * on.
 *
 * The finder is the ONE implementation (scripts/verification/hermetic-skips.ts):
 * it finds a skip by its SHAPE in the syntax tree, never by its words, over the
 * whole hermetic population (the engine runner's sources, the vitest include,
 * the Playwright specs). Every site it found was fixed at its cause, so this
 * guard admits none: no ownership, no baseline — a new site is a red.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hermeticSkipFindings, hermeticSources, skipSites } from "../../scripts/verification/hermetic-skips.ts";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The sites of a planted source, `line: shape`. */
function found(lines: readonly string[]): readonly string[] {
  return skipSites("probe.test.ts", lines.join("\n")).map((site) => `${String(site.line)}: ${site.shape}`);
}

test("every skipping spelling is found by its shape: a skip call, a skip option, a chosen skip, a skipping helper", () => {
  assert.deepEqual(found([
    'test("a", (t) => { t.skip("no host"); });',
    'test("b", { skip: !available && "no unshare" }, () => undefined);',
    'const options = { skip: true }; test("c", options, () => undefined);',
    'it.skipIf(report === null)("d", () => undefined);',
    'describe.skip("e", () => undefined);',
    'test("f", async (context) => { context.skip(); });',
    'it.runIf(process.env.X)("g", () => undefined);',
    'it.todo("h");',
    'const maybe = linux ? it : it.skip; maybe("i", () => undefined);',
    'test("j", (t) => { skipUnlessLinux(t); run(); });',
    'test("k", ({ browserName }) => { test.skip(browserName !== "chromium", "chromium only"); });',
  ]), [
    "1: .skip(…)", "2: a { skip } option", "3: a { skip } option", "4: .skipIf(…)", "5: .skip(…)", "6: .skip(…)",
    "7: .runIf(…)", "8: .todo(…)", "9: a chosen .skip", "10: a skipping helper skipUnlessLinux(…)", "11: .skip(…)",
  ]);
});

test("a test body that returns green on the host is found, at any depth and through what the guard reads", () => {
  assert.deepEqual(found([
    'test("a", () => { if (!hostConfines) return; run(); });',
    'test("b", () => { if (process.platform !== "linux") return; run(); });',
    'test("c", () => { if (!existsSync(binary)) { return; } run(); });',
    'test("d", () => { if (os.platform() !== "linux") return; run(); });',
    'test("e", () => { if (sep !== "/") return; run(); });',
    'test("f", () => { if (process.getuid?.() === 0) return; run(); });',
    'test("g", () => { try { if (!canCompile()) return; run(); } finally { done(); } });',
    'const confined = probe(); test("h", () => { if (!confined) return; run(); });',
    'describe("i", () => { let ready; beforeAll(() => { ready = probe(); }); it("i1", () => { if (!ready) return; run(); }); });',
    'test("j", () => { const linux = process.platform === "linux"; if (!linux) return; run(); });',
    'if (process.platform === "linux") { test("k", () => run()); }',
    'it.each([1, 2])("l %d", (n) => { if (!hasSystemd()) return; run(n); });',
    'test("m", async (t) => { await t.test("m1", () => { if (!wslDrive) return; run(); }); });',
    'function body() { if (!hostConfines) return; run(); } test("n", body);',
    'test("o", () => { if (process.env.CI) { run(); } else { return; } });',
  ]), [
    "1: an early return on the host", "2: an early return on the host", "3: an early return on the host", "4: an early return on the host",
    "5: an early return on the host", "6: an early return on the host", "7: an early return on the host", "8: an early return on the host",
    "9: an early return on the host", "10: an early return on the host", "11: a test registered only on the host", "12: an early return on the host",
    "13: an early return on the host", "14: an early return on the host", "15: an early return on the host",
  ]);
});

test("the finder does not fire on words, on the test's own data, or on code that is not a test body", () => {
  assert.deepEqual(found([
    'const fixture = \'test("a", { skip: true }, () => undefined);\';',
    '// t.skip() in a comment',
    'page({ skip: 10, take: 5 });',
    'test("b", () => { for (const x of xs) { if (x.done) return; } });',
    'test("c", () => { const count = rows().length; if (count === 0) { return; } run(); });',
    'test("d", () => { const probe = () => { if (!existsSync(p)) return false; return true; }; assert.ok(probe()); });',
    'test("e", () => { if (backend.release(id)) return; run(); });',
    'const FIXTURE = [1, 2]; test("f", () => { const n = FIXTURE.length; if (n === 0) return; run(); });',
    'test("g", () => { if (process.pid === 0) return; run(); });',
    'test("h", () => { requireHost(hostConfines, "Landlock"); run(); });',
    'test("i", () => { const ready = compute(); if (!ready) { // skipping, says only a comment\n return; } run(); });',
  ]), []);
});

test("the hermetic population is the whole tree, Playwright specs included", () => {
  const sources = hermeticSources(REPOSITORY_ROOT);
  assert.ok(sources.length > 500, `the hermetic population is the whole tree (found ${String(sources.length)})`);
  for (const [folder, suffix] of [["engine/test/", ".test.ts"], ["tests/", ".test.ts"], ["tests/", ".spec.ts"]] as const) {
    assert.ok(sources.some((path) => path.startsWith(folder) && path.endsWith(suffix)), `the population holds ${folder}…${suffix}`);
  }
});

test("the hermetic suites hold no skip (UR-20, UR-24): every one was fixed at its cause, and none is admitted", () => {
  assert.deepEqual(hermeticSkipFindings(REPOSITORY_ROOT), [],
    "a hermetic test that may skip: assert the host capability it needs by name (engine/test/support/host-requirement.ts), assert the tree content it reads, or move it to the live suite (engine/live/, `npm run test:live`)");
});
