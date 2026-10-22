/**
 * THE PROFILE'S VALIDATION (merge-door-final §5.2, T-P10): every rule it
 * refuses by, with the JSON pointer of the violation, and the selection of a
 * profile among the ones a source holds.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { parsePromotionProfile, profileCommandNames, selectPromotionProfile } from "../../../src/workflow/promotion/profile.ts";
import { PROFILE_DIRECTORY, PROFILE_NAME, PROFILE_PATH, fixtureProfile, json } from "./promotion-fixture.ts";

const COMMANDS: ReadonlySet<string> = new Set(["lockfile", "gate"]);

function pointers(profile: unknown, path = PROFILE_PATH): readonly string[] {
  try {
    parsePromotionProfile(typeof profile === "string" ? profile : json(profile), { path, profileDirectory: PROFILE_DIRECTORY, commandNames: COMMANDS });
  } catch (error) {
    assert.ok(error instanceof PromotionError && error.promotionCode === "promotion_profile_invalid", String(error));
    return (error.facts["violations"] as readonly { pointer: string }[]).map((violation) => violation.pointer);
  }
  return [];
}

test("T-P10: a valid profile parses; its commands are the phases' and the transforms'", () => {
  assert.deepEqual(pointers(fixtureProfile()), []);
  const profile = parsePromotionProfile(json(fixtureProfile()), { path: PROFILE_PATH, profileDirectory: PROFILE_DIRECTORY, commandNames: COMMANDS });
  assert.deepEqual(profileCommandNames(profile), ["gate", "lockfile"]);
  assert.ok(Object.isFrozen(profile));
});

test("T-P10: every invalid profile is refused with the pointer of its violation", () => {
  assert.deepEqual(pointers({ ...fixtureProfile(), unknown: 1 }), ["/"]);
  assert.deepEqual(pointers(fixtureProfile({ phases: { setup: [], converge: [], verify: ["missing-command"] } })), ["/phases/verify/0"]);
  assert.deepEqual(pointers(fixtureProfile({ transforms: [{ kind: "lockfile", path: "package-lock.json", manifest: "package.json", command: "lockfile" }] })), ["/transforms/0/manifest"]);
  assert.deepEqual(pointers(fixtureProfile({ boundary: { exclude: ["dev/", "promotion/", "dev/"] } })), ["/boundary/exclude"]);
  assert.deepEqual(pointers(fixtureProfile({ boundary: { exclude: ["dev/"] } })), ["/boundary/exclude"], "the profile directory must be excluded");
  assert.deepEqual(pointers(fixtureProfile({ boundary: { include: ["dev/x.ts"] } })), ["/boundary/include/0"], "a path both included and excluded");
  assert.deepEqual(pointers(fixtureProfile(), `${PROFILE_DIRECTORY}/another-name.json`), ["/name"]);
  assert.deepEqual(pointers(fixtureProfile({ target: { ref: `refs/heads/dev` } })), ["/target/ref"], "the same ref twice");
  assert.deepEqual(pointers(fixtureProfile({ target: { ref: "refs/heads/bad..ref" } })), ["/target/ref"], "git refuses the name");
  assert.deepEqual(pointers(fixtureProfile({ boundary: { include: ["/absolute"] } })), ["/boundary/include/0"]);
  assert.deepEqual(pointers(json(fixtureProfile()).replace('"trigger"', '"trigger": "manual",\n  "trigger"')), ["/"], "a repeated key");
  assert.deepEqual(pointers("{ not json"), ["/"]);
  // L15: a derived path also excluded would ship and not ship at once.
  assert.deepEqual(pointers(fixtureProfile({ boundary: { exclude: ["dev/", "promotion/", "package-lock.json"] } })), ["/transforms/1/path", "/boundary/include/5"], "the fixture also includes it");
  // L6: a spawn call's base is the top (`""`) or a folder prefix of the repository, never an escape.
  for (const base of ["../", "./", "a/../b/", "file.ts"]) {
    assert.deepEqual(pointers(fixtureProfile({ boundary: { spawnCalls: [{ callee: "runScript", argument: 1, base }] } })), ["/boundary/spawnCalls/0/base"], base);
  }
  assert.deepEqual(pointers(fixtureProfile({ boundary: { spawnCalls: [{ callee: "runScript", argument: 1, base: "" }] } })), []);
});

test("the overlay: a folder prefix the boundary excludes, apart from the profile directory", () => {
  const overlay = (value: unknown, exclude: readonly string[] = ["dev/", "promotion/", "target-only/"]): readonly string[] => pointers(fixtureProfile({ boundary: { overlay: value, exclude } }));
  assert.deepEqual(overlay("target-only/"), [], "an excluded folder prefix");
  assert.deepEqual(overlay("dev/nested/"), [], "a folder inside an excluded one");
  assert.deepEqual(overlay("target-only/", ["dev/", "promotion/"]), ["/boundary/overlay"], "a folder the boundary does not exclude would also ship at its own path");
  for (const value of ["target-only", "/target-only/", "../target-only/", "./", "README.md"]) assert.deepEqual(overlay(value), ["/boundary/overlay"], `${value}: not a repository folder prefix`);
  assert.deepEqual(overlay("promotion/"), ["/boundary/overlay"], "the profile directory never ships, through an overlay either");
  assert.deepEqual(overlay("promotion/target/", ["dev/", "promotion/"]), ["/boundary/overlay"], "nor a folder inside it");
  const withoutOverlay = fixtureProfile();
  delete (withoutOverlay["boundary"] as Record<string, unknown>)["overlay"];
  assert.deepEqual(pointers(withoutOverlay), ["/boundary/overlay"], "the field is stated (null: none), never defaulted");
});

test("selecting a profile: by name, or the only one; otherwise refused as missing", () => {
  const loaded = [{ profile: parsePromotionProfile(json(fixtureProfile()), { path: PROFILE_PATH, profileDirectory: PROFILE_DIRECTORY, commandNames: COMMANDS }), path: PROFILE_PATH, blob: null }];
  assert.equal(selectPromotionProfile(loaded, undefined, "here").profile.name, PROFILE_NAME);
  assert.equal(selectPromotionProfile(loaded, PROFILE_NAME, "here").path, PROFILE_PATH);
  assert.throws(() => selectPromotionProfile(loaded, "other", "here"), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_profile_missing");
  assert.throws(() => selectPromotionProfile([], undefined, "here"), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_profile_missing");
});
