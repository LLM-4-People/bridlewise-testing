// @vitest-environment node
/**
 * THE PERFORMANCE SUITE MAY NOT RE-CREATE THE RETIRED SIBLING-CHECKOUT TREE.
 *
 * ── THE DEFECT, WHICH WAS FOUND BY READING ────────────────────────────────
 *
 * `DEFAULT_SCRATCH_ROOT` lives under a shared workspaces tree
 * (`/home/example/code-harness-workspaces`). A cleanup may retire that tree.
 * Three call sites reached the scratch root through `mkdirSync(..., { recursive:
 * true })`, and `recursive` creates every missing PARENT — so the first
 * performance run after that retirement would have silently put the directory
 * back, reported nothing, and exited 0. The retirement would appear not to have
 * taken, and nothing would connect the two events.
 *
 * That is not a broken path. It is a green run undoing a deliberate act, which
 * is this project's standing failure mode wearing a scratch directory.
 *
 * ── THE §41 SEARCH, RECORDED ──────────────────────────────────────────────
 *
 * Q1 — was anything already supposed to catch it? No. `tests/performance/` held
 * exactly one `.test.ts`, `regression.test.ts`, whose declared subject is the
 * Playwright profile report and its per-route budgets. It reads a report; it
 * has no opinion about where fixtures are copied to. Not blind inside its own
 * subject — a different subject.
 *
 * Q2 — is anything similar? No. Nothing under `tests/` referenced
 * `performance/scale` at all before this file; the two modules there were
 * imported only by the Playwright specs, which run under a separate config and
 * are therefore not a suite that runs unattended. So this is a new file, and
 * both answers are recorded above rather than assumed.
 *
 * ── WHY THIS IS A TEST AND NOT A COMMENT ──────────────────────────────────
 *
 * The refusal is one `existsSync` and an easy thing to delete in a hurry —
 * `mkdirSync(root, { recursive: true })` is the shorter spelling and looks
 * identical to every other scratch directory in the tree. The arm below fails
 * the moment somebody restores it.
 */
import { AssertionError } from "node:assert/strict";
import { readPreparedProfileFixture } from "../lib/perf-harness.ts";
import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DEFAULT_SCRATCH_ROOT,
  prepareCockpitFixture,
  scratchRootParentOrRefuse,
} from "./prepare-fixture.ts";

import { createTempDir } from "../../helpers/temp-dir.ts";
import { verifyPassword } from "../../../server/auth/auth.ts";
import { resetServerConfig, serverConfig } from "../../../server/kernel/config.ts";
import { DbClient } from "../../../server/db/client.ts";
import { admitKeyHome } from "../../../engine/src/filesystem/self-protection/key-home.ts";

const REPO_ROOT = resolve(process.cwd());

describe("the performance scratch root refuses rather than resurrecting its parent", () => {
  test("an absent parent is a refusal that names the directory and the remedy", () => {
    // A path nobody has created, under a parent that does not exist. Built
    // rather than written down, so it cannot accidentally name something real.
    const absent = join("/home/example", `no-such-tree-${String(process.pid)}-9f3a`, ".perf-scratch");
    expect(existsSync(dirname(absent)), `${dirname(absent)} exists — the fixture is not testing a refusal`).toBe(false);

    let message = "";
    // NOT a bare `.toThrow()`. A bare one passes on any error at all —
    // including a TypeError from a refactor that broke the call — and would
    // report "the refusal works" while measuring a crash. The pattern names
    // the specific refusal, and the assertions below name its content.
    expect(() => scratchRootParentOrRefuse(absent)).toThrowError(
      /Performance scratch root unavailable: its parent directory .* does not exist/,
    );
    try {
      scratchRootParentOrRefuse(absent);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Assert on the SPECIFIC content, never a bare throw: the refusal has to
    // tell an operator which directory is missing, that its absence is a
    // decision rather than a bug, and what to do next.
    expect(message).toContain(dirname(absent));
    expect(message).toContain("does not exist");
    expect(message).toContain("NOT created automatically on purpose");
    // The refusal must name the parent it refused to resurrect — derived from
    // the probe, never a hardcoded tree name, so a workspace rename cannot
    // strand this assertion on a retired spelling.
    expect(message).toContain(`resurrect ${dirname(absent)}`);

    // THE OTHER ARM, which is what makes the first one mean something. A
    // function that threw unconditionally would satisfy every assertion above
    // and break the suite for everyone — so prove it PASSES a real parent.
    // §36: the absence claim needs a witness that the instrument works.
    const present = join(REPO_ROOT, "bench", ".perf-scratch-probe");
    expect(existsSync(dirname(present))).toBe(true);
    expect(scratchRootParentOrRefuse(present)).toBe(present);
  });

  test("no scratch path is reached through a bare recursive mkdir", () => {
    // The defect's actual shape, asserted against the source of the two modules
    // that own it. Every `mkdirSync` whose argument mentions the scratch root
    // must go through the asking function; a bare one re-creates the parent.
    //
    // DERIVED, not listed: the files come from this directory's own two
    // modules, and an empty match set is a RED rather than a pass — a scan
    // whose universe came back empty has certified nothing.
    const owners = ["prepare-fixture.ts", "stack.ts"];
    let mkdirCalls = 0;
    for (const owner of owners) {
      const source = readFileSync(join(REPO_ROOT, "tests/performance/scale", owner), "utf8");
      for (const line of source.split("\n")) {
        // COMMENT LINES ARE NOT CALL SITES, and this scan learned that the
        // expensive way: its first version red on the paragraph in
        // `prepare-fixture.ts` that QUOTES the forbidden spelling in order to
        // explain why it is forbidden. A guard whose own subject's
        // documentation trips it is a guard nobody can leave green, and the
        // pressure is then to delete the explanation rather than the defect.
        const code = line.trimStart();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
        if (!line.includes("mkdirSync(")) continue;
        if (!/SCRATCH_ROOT|scratchRoot/.test(line)) continue;
        mkdirCalls += 1;
        expect(
          line,
          `${owner}: this mkdirSync reaches the scratch root without asking whether its parent ` +
            `exists. \`recursive: true\` creates parents, and this root's parent is a workspaces ` +
            `tree a cleanup may retire — so a run after that retirement puts it back in ` +
            `silence. Route it through scratchRootParentOrRefuse().`,
        ).toContain("scratchRootParentOrRefuse");
      }
    }
    // LIVENESS: if the spelling changes and this scan matches nothing, it must
    // fail rather than certify zero call sites.
    expect(
      mkdirCalls,
      "no mkdirSync naming the scratch root was found in either owner — this scan's universe " +
        "is empty, which is a broken scan and not a clean result",
    ).toBeGreaterThan(0);

    // And the constant still names a shared workspaces tree OUTSIDE this
    // repository — the property the refusal exists to protect. Assert the
    // shape (a workspaces tree that is not this repo), never a retired name,
    // so a workspace rename cannot strand the guard on a stale spelling. If
    // the root is ever moved somewhere the resurrection hazard is gone, this
    // test should be deleted deliberately rather than left passing over a
    // subject that no longer exists.
    expect(DEFAULT_SCRATCH_ROOT, "the scratch root must sit outside this repo").not.toContain(REPO_ROOT);
    expect(DEFAULT_SCRATCH_ROOT, "the scratch root must sit under a workspaces tree").toContain("-workspaces/");
  });
});


test("cockpit preparation refuses existing data before opening a writer", async () => {
  const directory = createTempDir("profile-owned-refusal-");
  const file = join(directory, "db", "projection.db");
  mkdirSync(join(directory, "db"));
  writeFileSync(file, "existing caller data must survive refusal");
  await expect(prepareCockpitFixture(directory)).rejects.toThrowError(expect.objectContaining({ constructor: AssertionError, code: "ERR_ASSERTION", message: expect.stringContaining("fresh cockpit fixture path required") }));
  expect(readFileSync(file, "utf8")).toBe("existing caller data must survive refusal");
  expect(existsSync(join(directory, "keys"))).toBe(false);
  expect(existsSync(join(directory, "profile-manifest.json"))).toBe(false);
});


test("cockpit preparation adopts the migration-seeded admin instead of colliding on it", { timeout: 60_000 }, async () => {
  // ── THE DEFECT, WHICH WAS REPRODUCED AT THE CURRENT BYTES ────────────
  //
  // Receipt: docs/findings/recovery/evidence/fix06-runtime/profile/
  // fixture-repro-prepare.log.txt — the direct fixture CLI, run with
  // HARNESS_WEB_AUTH_PASSWORD set against a fresh path, died at native
  // exit 1 with `UNIQUE constraint failed: users.username`. The mechanism:
  // prepare requires that password, then opens its fresh DbClient — whose
  // v12 migration seeds the configured admin (serverConfig.authUsername,
  // hashed from the same environment password) — and then created that
  // identity AGAIN, spelled as a literal. Two creators, one UNIQUE
  // column, no owner of the decision.
  //
  // ── THE §41 SEARCH, RECORDED ─────────────────────────────────────────
  //
  // Q1 — was anything already supposed to catch it? No. This file's cockpit
  // arms cover the REFUSALS (existing caller data, manifest shape); the
  // happy-path prepare had never run inside the suite — the corpus build
  // was reached only through the manual CLI, which is exactly how a
  // collision survived every green run to be found by the F2 profile
  // reproduction.
  //
  // Q2 — is anything similar? No other test drives prepare against a
  // database the migrations have already seeded, and none sets the auth
  // password env and re-resolves the config singleton to make the seed
  // happen in-process.
  //
  // ── WHY THIS DRIVE ───────────────────────────────────────────────────
  //
  // The password env is set and serverConfig re-resolved, so the v12
  // migration — running on prepare's OWN fresh connection, inside this
  // process — seeds the admin exactly as the CLI run does. On the old
  // bytes this test is red BY CONSTRUCTION: the seeded row exists, and
  // prepare's blind createUser('admin') dies with the same
  // UNIQUE-constraint failure the receipt recorded. The assertions then
  // prove the fix is an ADOPTION and not a swallow: exactly one identity,
  // the configured one, still the first admin, and its password is the
  // caller's — the login contract the profile depends on.
  const password = "cockpit-seeded-admin-login-password";
  process.env["HARNESS_WEB_AUTH_PASSWORD"] = password;
  resetServerConfig();
  try {
    // THE PREMISE, WITNESSED (§36): the v12 seed is what makes the old blind
    // createUser a collision, so the seed is OBSERVED under this process's
    // config state before prepare is judged — a silent drift in the seeding
    // condition or the reset would otherwise flip this test to prepare's
    // createUser arm and stay green over a dead premise.
    const witnessDir = createTempDir("profile-seed-witness-");
    const witnessHome = admitKeyHome(join(witnessDir, "keys"), [{ path: join(witnessDir, "db"), what: "the witness database folder" }]);
    const witness = new DbClient({ path: join(witnessDir, "db", "witness.db"), keyHome: witnessHome });
    try {
      expect(witness.countUsers(), "v12 seeds the configured admin on a fresh connection under this env").toBe(1);
      const seededAdmin = witness.getUserByUsername(serverConfig.authUsername);
      if (seededAdmin === null) throw new Error(`the v12 seed produced no ${serverConfig.authUsername} row`);
      expect(seededAdmin.is_admin, "the seed makes the configured identity the FIRST admin").toBe(1);
    } finally {
      witness.close();
    }
    const directory = createTempDir("profile-seeded-admin-");
    const prepared = await prepareCockpitFixture(directory);
    expect(existsSync(prepared.manifestPath), "a completed preparation writes its manifest").toBe(true);
    // The manifest type declares keyHome as a plain path; the client wants it
    // admitted — the same door prepare went through, re-asked for the read.
    const keyHome = admitKeyHome(prepared.keyHome, [{ path: dirname(prepared.dbPath), what: "the fixture's database folder" }]);
    const db = new DbClient({ path: prepared.dbPath, keyHome, readOnly: true });
    try {
      expect(db.countUsers(), "the fixture ADOPTED the seeded admin — a second identity is the old defect").toBe(1);
      const admin = db.getUserByUsername(serverConfig.authUsername);
      if (admin === null) throw new Error(`the prepared fixture has no ${serverConfig.authUsername} row`);
      expect(admin.is_admin, "the fixture admin is the seeded FIRST user, not a late non-admin row").toBe(1);
      expect(await verifyPassword(password, admin.password_hash), "the fixture admin's password is the caller's — the profile logs in with the same variable").toBe(true);
    } finally {
      db.close();
    }
  } finally {
    delete process.env["HARNESS_WEB_AUTH_PASSWORD"];
    resetServerConfig();
  }
});


test("prepared cockpit manifests require complete distinct populations before login", () => {
  const directory = createTempDir("profile-manifest-refusal-");
  const path = join(directory, "profile.json");
  const fixture = { dbPath: join(directory, "db", "projection.db"), keyHome: join(directory, "keys"), closedBeforeServing: true, projectIds: Array.from({ length: 10000 }, (_, index) => `p${index}`), chatIds: Array.from({ length: 10000 }, (_, index) => `c${index}`), longChat: { projectId: "p0", chatId: "c0", messageCount: 1000, messageIds: Array.from({ length: 1000 }, (_, index) => `m${index}`) } };
  const refused = (reason: string) => expect.objectContaining({ constructor: AssertionError, code: "ERR_ASSERTION", message: expect.stringContaining(reason) });
  expect(() => readPreparedProfileFixture(undefined)).toThrowError(refused("HARNESS_PERF_FIXTURE_PATH must name"));
  writeFileSync(path, JSON.stringify(fixture));
  expect(readPreparedProfileFixture(path)).toEqual(fixture);
  fixture.projectIds[9999] = fixture.projectIds[0]!;
  writeFileSync(path, JSON.stringify(fixture));
  expect(() => readPreparedProfileFixture(path)).toThrowError(refused("projects distinct prepared population"));
  fixture.projectIds[9999] = "p9999";
  fixture.longChat.messageIds.pop();
  writeFileSync(path, JSON.stringify(fixture));
  expect(() => readPreparedProfileFixture(path)).toThrowError(refused("messages prepared population"));
});
