// The declared-corpus refusal, driven both ways.
//
// This exists because an absent corpus once cost two whole engine suite runs
// and produced no receipt either time: the tests that read it did not fail,
// they waited. The verdict below is pure over the filesystem answers it is
// handed, so both arms are drivable without planting 4 GB anywhere.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  REQUIRED_FIXTURE_ROOTS,
  judgeFixtureRoots,
  checkRequiredFixtureRoots,
} from "../../scripts/verification/required-fixture-roots.ts";

test("required-fixture-roots: the declaration is real and says how to obtain each root", () => {
  // A declaration nobody can act on is a dead end at exactly the moment
  // someone is looking at an unfamiliar tree.
  assert.ok(REQUIRED_FIXTURE_ROOTS.length > 0, "the declared set must not be empty");
  for (const root of REQUIRED_FIXTURE_ROOTS) {
    assert.ok(root.path.length > 0, "a declared root must name a path");
    assert.ok(root.purpose.length > 20, `${root.path} must say what stops working without it`);
    assert.ok(root.provenance.length > 20, `${root.path} must say how to obtain it`);
  }
});

test("required-fixture-roots: an absent root REFUSES, and the refusal names it", () => {
  const verdict = judgeFixtureRoots(REQUIRED_FIXTURE_ROOTS, () => false);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.missing.length, REQUIRED_FIXTURE_ROOTS.length);
  const message = verdict.message ?? "";
  for (const root of REQUIRED_FIXTURE_ROOTS) {
    assert.ok(message.includes(root.path), `the refusal must name ${root.path}`);
    assert.ok(message.includes(root.provenance), `the refusal must say how to get ${root.path}`);
  }
});

test("required-fixture-roots: present roots pass, and the pass carries no message", () => {
  // The witness for the arm above: the same declaration, the same judge, and
  // the only thing that changed is the filesystem's answer.
  const verdict = judgeFixtureRoots(REQUIRED_FIXTURE_ROOTS, () => true);
  assert.equal(verdict.ok, true);
  assert.deepEqual([...verdict.missing], []);
  assert.deepEqual([...verdict.missingReadme], []);
  assert.equal(verdict.message, null);
});

test("required-fixture-roots: a present root whose README is gone is a refusal, and names the README", () => {
  // The corpus README is untracked by design (the corpus is a gitignored
  // symlink target), so the tracked-index freshness census can never see it.
  // This declaration is the honest backstop: the root exists but its README
  // does not, and the refusal must name the README so the loss is reported
  // rather than silent. Drive: the root present, the README absent.
  const verdict = judgeFixtureRoots(REQUIRED_FIXTURE_ROOTS, (path) => path !== "large-codebases/README.md");
  assert.equal(verdict.ok, false);
  assert.deepEqual([...verdict.missing], []);
  assert.deepEqual(
    verdict.missingReadme.map((entry) => entry.readme),
    ["large-codebases/README.md"],
  );
  const message = verdict.message ?? "";
  assert.ok(message.includes("large-codebases/README.md"), "the refusal must name the missing README");
  assert.ok(message.includes("untracked by design"), "the refusal must say why nothing else reports it");
});

test("required-fixture-roots: every declared root names the README that documents it", () => {
  // Deny-by-default on the declaration itself: a required fixture root whose
  // corpus is gitignored must declare its README, or the README is covered by
  // nothing. The field is required by the type; this asserts it is a real
  // repo-relative README path, not an empty string.
  for (const root of REQUIRED_FIXTURE_ROOTS) {
    assert.ok(root.readme.length > 0, `${root.path} must name the README that documents it`);
    assert.ok(root.readme.startsWith(`${root.path}/`), `${root.path}'s README must live inside the root`);
    assert.ok(root.readme.endsWith("README.md"), `${root.path}'s README must be a README.md`);
  }
});

test("required-fixture-roots: one absent among several is still a refusal", () => {
  const declared = [
    { path: "present-one", purpose: "a".repeat(30), provenance: "b".repeat(30), readme: "present-one/README.md" },
    { path: "absent-one", purpose: "c".repeat(30), provenance: "d".repeat(30), readme: "absent-one/README.md" },
  ] as const;
  const verdict = judgeFixtureRoots(declared, (path) => path === "present-one" || path === "present-one/README.md");
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing.map((entry) => entry.path), ["absent-one"]);
  assert.ok(!(verdict.message ?? "").includes("present-one"));
});

test("required-fixture-roots: the live check answers about THIS repository", () => {
  // Liveness: the exported check must be wired to the real filesystem, not a
  // constant. A repository missing its corpora is a legitimate state, so this
  // asserts the SHAPE of the answer rather than a particular verdict.
  const verdict = checkRequiredFixtureRoots(process.cwd());
  assert.equal(typeof verdict.ok, "boolean");
  assert.equal(verdict.ok, verdict.missing.length === 0);
  assert.equal(verdict.ok ? verdict.message : typeof verdict.message, verdict.ok ? null : "string");
});

test("required-fixture-roots: the corpus check gates the RUN and not the manifest sub-CLI", () => {
  // ── THE DEFECT THIS ORDER EXISTS TO PREVENT, MEASURED ─────────────────────
  //
  // The check began life at the top of `runCli`, where it refused every
  // INVOCATION rather than every run. `harness regenerate` invokes the same
  // CLI as a subprocess with `--auto-add-dispositions` to edit the disposition
  // manifest, and it does so on whatever root it is given — including the
  // throwaway fixture trees `harness-commands.test.ts` builds, which copy
  // `src/ scripts/ verification/ traceability/ test/` and by design carry no
  // 4 GB corpus. The refusal went out on the stdout channel the caller parses
  // as its JSON payload, and the whole suite went red with
  // `parsed.addedPaths is not iterable`: a declaration about the SUITE
  // stopping a manifest edit that reads none of it.
  //
  // WHY THIS IS ASSERTED ON ORDER AND NOT ONLY ON BEHAVIOUR. The behaviour is
  // covered — `HarnessCommands: harnessRegenerate write=true auto-adds missing
  // disposition entries for new test files` runs the real subprocess against a
  // real corpus-less tree, and it is what went red. What that test cannot say
  // is that the check still precedes the RUN, because it never reaches one.
  // Moving the block below `autoHealTestInventory()` would keep it green and
  // give back the eighteen minutes. So both landmarks are pinned, by NAME
  // rather than by byte: the identifiers are what a reformat leaves alone and
  // a reordering does not.
  const source = readFileSync(new URL("../../scripts/tooling/run-tests.ts", import.meta.url), "utf8");
  const at = (needle: string): number => {
    const index = source.indexOf(needle);
    assert.notEqual(index, -1, `${needle} is no longer in scripts/run-tests.ts — this order check is stale`);
    return index;
  };
  const subCli = at('argv[0] === "--auto-add-dispositions"');
  const corpusCheck = at("checkRequiredFixtureRoots(root)");
  const heal = at("await autoHealTestInventory()");
  assert.ok(
    subCli < corpusCheck,
    "the manifest sub-CLI must return before the corpus check, or a tree with no corpus cannot have its manifest repaired",
  );
  assert.ok(
    corpusCheck < heal,
    "the corpus check must precede the first thing the run does, or an absent corpus is discovered by waiting",
  );
});
