/**
 * THE TEMP ROOT (`src/filesystem/temporary-root.ts`): both runners state its
 * headroom before a run and warn when bytes OR inodes are under the policy's
 * free share (the tmpfs here ran out of inodes while bytes were free); and
 * both runners and the server REFUSE a temp root inside the safety floor
 * (TMPDIR-KEEPOUT-001), where the harness would refuse its own temporaries.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { temporaryRootHeadroom, temporaryRootKeepOutRefusal, temporaryRootPreflightLine } from "../../src/filesystem/temporary-root.ts";
import { PRODUCT_NAME } from "../../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

test("the headroom is measured (bytes and inodes as shares), and a low share of EITHER warns", () => {
  const measured = temporaryRootHeadroom(createTempDir("temporary-root-"));
  assert.ok(measured !== undefined);
  for (const fraction of [measured.freeBytesFraction, measured.freeInodesFraction]) assert.ok(fraction >= 0 && fraction <= 1);
  const minimum = ROOT_POLICY.filesystemInfrastructure.temporaryRootMinimumFreeFraction;
  const line = (bytes: number, inodes: number): string =>
    temporaryRootPreflightLine("probe", { root: "/tmp", freeBytesFraction: bytes, freeInodesFraction: inodes, low: bytes < minimum || inodes < minimum });
  assert.match(line(0.5, minimum / 2), /WARNING — the temp root is nearly full/u, "inodes alone must warn");
  assert.match(line(minimum / 2, 0.5), /WARNING/u, "bytes alone must warn");
  assert.doesNotMatch(line(0.5, 0.5), /WARNING/u);
  assert.match(temporaryRootPreflightLine("probe", undefined), /unknown/u);
});

/** A private home holding a checkout under `~/.local/state/<product>-cand/` and a credential store. */
function plantedHome(): Readonly<{ home: string; harnessRoot: string; state: string }> {
  const home = createTempDir("temporary-root-home-");
  const state = join(home, ".local", "state");
  const harnessRoot = join(state, `${PRODUCT_NAME}-cand`, "repo", "engine");
  for (const folder of [harnessRoot, join(state, `${PRODUCT_NAME}-tmp`, "run"), join(state, `${PRODUCT_NAME}-cand`, "tmp"), join(home, ".cache", `${PRODUCT_NAME}-tmp`, "run"), join(home, ".ssh", "t")]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
  }
  return { home, harnessRoot, state };
}

function withHome<T>(home: string, body: () => T): T {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return body(); } finally { process.env.HOME = previous; }
}

test("a temp root INSIDE the floor (another harness state folder, a credential store) is refused; one outside it, or in the checkout's own state folder, is not", () => {
  const { home, harnessRoot, state } = plantedHome();
  withHome(home, () => {
    const sibling = temporaryRootKeepOutRefusal(harnessRoot, join(state, `${PRODUCT_NAME}-tmp`, "run"));
    assert.ok(sibling !== undefined, "a temp root under ~/.local/state/<product>-tmp was accepted");
    assert.ok(sibling.includes(`lies inside the safety floor's keep-out entry ${join(state, PRODUCT_NAME)}-*`), sibling);
    assert.match(sibling, /set TMPDIR to a private folder outside the floor/u);
    assert.ok((temporaryRootKeepOutRefusal(harnessRoot, join(home, ".ssh", "t")) ?? "").includes(`lies inside the safety floor's keep-out entry ${join(home, ".ssh")}`), "a temp root inside ~/.ssh was accepted");
    assert.match(temporaryRootKeepOutRefusal(harnessRoot, home) ?? "", /holds the safety floor's keep-out entry/u, "a temp root that HOLDS a store (the home itself) was accepted");
    assert.equal(temporaryRootKeepOutRefusal(harnessRoot, join(home, ".cache", `${PRODUCT_NAME}-tmp`, "run")), undefined);
    // The checkout's own installation folder is the harness's, excepted from the wildcard.
    assert.equal(temporaryRootKeepOutRefusal(harnessRoot, join(state, `${PRODUCT_NAME}-cand`, "tmp")), undefined);
    // wf-1b3a-correctness L7: a relative temp root is the same one-line refusal, never a thrown "must be absolute".
    assert.match(temporaryRootKeepOutRefusal(harnessRoot, "relative/tmp") ?? "", /is a relative path/u);
  });
});

/** A folder with the owned-temporary shape whose owner (pid 99999999) is dead. */
function plantDeadOwnerTemporary(parent: string): string {
  const nonce = "0".repeat(ROOT_POLICY.filesystemInfrastructure.privateState.temporaryRandomBytes * 2);
  const folder = join(parent, `probe-99999999-1-${nonce}`);
  mkdirSync(folder, { recursive: true });
  return folder;
}

test("DRIVEN: both test runners refuse to start under a temp root inside the floor, naming the code — and the engine runner still sweeps what ended processes left there", () => {
  const { home, state } = plantedHome();
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const environment = { ...process.env, HOME: home, TMPDIR: join(state, `${PRODUCT_NAME}-tmp`, "run") };
  const abandoned = plantDeadOwnerTemporary(environment.TMPDIR);
  const engine = spawnSync(process.execPath, ["--experimental-strip-types", join(repository, "engine", "scripts", "tooling", "run-tests.ts")], {
    cwd: join(repository, "engine"), env: environment, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(engine.status, 1, engine.stderr);
  assert.match(engine.stdout, /"error":"temporary_root_kept_out"/u);
  // wf-1b3a-correctness M2 (V7): the end-of-run sweep is wired whatever the run's ending.
  assert.equal(existsSync(abandoned), false, "the engine runner's end-of-run sweep did not run");
  assert.match(engine.stderr, /\[run-tests\] removed 1 temporary folder\(s\) left by ended processes/u);
  const web = spawnSync(process.execPath, ["--experimental-strip-types", join(repository, "scripts", "run-tests.ts")], {
    cwd: repository, env: environment, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(web.status, 1, web.stderr);
  assert.match(web.stderr, /REFUSED \(temporary_root_kept_out\)/u);
});

test("DRIVEN: the web runner sweeps what ended processes left in its temp root when its run ends", () => {
  // wf-1b3a-correctness M2 (V6). The shortest real run: a supervised vitest
  // run whose filter selects no file (a subset run: never a judged ledger row).
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const temporaryRoot = createTempDir("temporary-root-web-sweep-");
  const abandoned = plantDeadOwnerTemporary(temporaryRoot);
  const web = spawnSync(process.execPath, ["--experimental-strip-types", join(repository, "scripts", "run-tests.ts"), "--passWithNoTests", "tests/no-such-test-file-selected"], {
    cwd: repository, env: { ...process.env, TMPDIR: temporaryRoot }, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(web.status, 0, web.stderr);
  assert.equal(existsSync(abandoned), false, "the web runner's end-of-run sweep did not run");
  assert.match(web.stderr, /\[run-tests\] removed 1 temporary folder\(s\) left by ended processes/u);
});
