/**
 * THE PROFILE'S VALIDATION (merge-door-final §5.2, T-P10): every rule it
 * refuses by, with the JSON pointer of the violation, and the selection of a
 * profile among the ones a source holds.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { isOfOverlayKind, OVERLAY_KINDS, parsePromotionProfile, profileCommandNames, profileTreeViolations, selectPromotionProfile } from "../../../src/workflow/promotion/profile.ts";
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

test("the makefile transform: a file named Makefile and a list of distinct targets", () => {
  const base = (fixtureProfile() as { transforms: unknown[] }).transforms;
  const withMakefile = (transform: Record<string, unknown>): readonly string[] => pointers(fixtureProfile({ transforms: [...base, { kind: "makefile", ...transform }] }));
  const at = String(base.length);
  assert.deepEqual(withMakefile({ path: "Makefile", targets: ["build", "dev"] }), [], "the root Makefile");
  assert.deepEqual(withMakefile({ path: "product/Makefile", targets: ["build"] }), [], "a Makefile in a folder");
  for (const path of ["GNUmakefile", "Makefile.orig", "product/makefile", "build.mk"]) assert.deepEqual(withMakefile({ path, targets: ["build"] }), [`/transforms/${at}/path`], `${path}: not a file named Makefile`);
  assert.deepEqual(withMakefile({ path: "Makefile", targets: ["build", "build"] }), [`/transforms/${at}/targets`], "a target listed twice");
  for (const targets of [[], ["%.o"], ["a b"], [".PHONY"], ["$(X)"]]) assert.ok(withMakefile({ path: "Makefile", targets }).length > 0, `${JSON.stringify(targets)}: not a list of target names`);
  assert.deepEqual(withMakefile({ path: "Makefile", targets: ["build"], scripts: [] }), [`/transforms/${at}`], "no key of another kind");
});

test("a profile names only paths its checkout tracks: an absent file or an empty folder is named by its pointer (harness check, #279)", () => {
  const profile = fixtureProfile() as { boundary: { entryPoints: string[]; include: string[] } };
  const named = [...profile.boundary.entryPoints, ...profile.boundary.include];
  const tree = new Set(named.map((value) => (value.endsWith("/") ? `${value}held.ts` : value)));
  const parsed = parsePromotionProfile(json(profile), { path: PROFILE_PATH, profileDirectory: PROFILE_DIRECTORY, commandNames: COMMANDS });
  const parse = (presentPaths: ReadonlySet<string>): readonly string[] => profileTreeViolations(parsed, presentPaths).map(([pointer]) => pointer);
  assert.deepEqual(parse(tree), [], "every named path is held");
  const fileIndex = profile.boundary.include.findIndex((value) => !value.endsWith("/"));
  const deleted = new Set([...tree].filter((path) => path !== profile.boundary.include[fileIndex]));
  assert.deepEqual(parse(deleted), [`/boundary/include/${String(fileIndex)}`], "a deleted file the profile still names");
  const folderIndex = profile.boundary.include.findIndex((value) => value.endsWith("/"));
  if (folderIndex >= 0) {
    const emptied = new Set([...tree].filter((path) => !path.startsWith(profile.boundary.include[folderIndex]!)));
    assert.deepEqual(parse(emptied), [`/boundary/include/${String(folderIndex)}`], "a folder the tree holds nothing under");
  }
});

test("the overlay: a folder prefix the boundary excludes, apart from the profile directory, with kinds only from the fixed allowlist, compared without case", () => {
  const overlay = (folder: unknown, kinds: unknown = ["*.md", "*.txt"], exclude: readonly string[] = ["dev/", "promotion/", "target-only/"]): readonly string[] => pointers(fixtureProfile({ boundary: { overlay: { folder, kinds }, exclude } }));
  assert.deepEqual(overlay("target-only/"), [], "an excluded folder prefix");
  assert.deepEqual(overlay("dev/nested/"), [], "a folder inside an excluded one");
  assert.deepEqual(overlay("target-only/", undefined, ["dev/", "promotion/"]), ["/boundary/overlay/folder"], "a folder the boundary does not exclude would also ship at its own path");
  for (const value of ["target-only", "/target-only/", "../target-only/", "./", "README.md"]) assert.deepEqual(overlay(value), ["/boundary/overlay/folder"], `${value}: not a repository folder prefix`);
  assert.deepEqual(overlay("promotion/"), ["/boundary/overlay/folder"], "the profile directory never ships, through an overlay either");
  assert.deepEqual(overlay("promotion/target/", undefined, ["dev/", "promotion/"]), ["/boundary/overlay/folder"], "nor a folder inside it");
  const refusedKinds = [
    "*.ts", "*.mts", "*.cts", "*.tsx", "*.js", "*.mjs", "*.cjs", "*.jsx", "*.svelte", "*.css",
    "*.JS", "*.MTS", "*.Ts", "*.node", "*.wasm", "*.sh", "*.html", "*.HTML", "*.svg", "*.SVG", "*.json", "*.yml",
    "package.json", "npmrc", "pre-commit", "NOTICE", "Makefile", "makefile", "MAKEFILE", "Makefile.orig", "GNUmakefile",
  ];
  for (const kind of refusedKinds) assert.deepEqual(overlay("target-only/", ["*.md", kind]), ["/boundary/overlay/kinds/1"], `${kind}: not on the fixed allowlist, in any spelling`);
  assert.ok(overlay("target-only/", ["*.md", ".npmrc"]).length > 0, ".npmrc: not a kind at all");
  assert.deepEqual([...OVERLAY_KINDS], ["*.md", "*.txt", "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"], "the allowlist is fixed: documents and named images (a recipe is derived by the makefile transform)");
  assert.deepEqual(overlay("target-only/", [...OVERLAY_KINDS]), [], "every allowlisted kind is accepted");
  assert.deepEqual(overlay("target-only/", ["*.MD", "*.Png", "*.TXT"]), [], "compared without case");
  assert.deepEqual(overlay("target-only/", ["*.md", "*.MD"]), ["/boundary/overlay/kinds"], "one kind in two spellings is listed twice");
  assert.deepEqual([["README.MD", "*.md"], ["notes.txt", "*.TXT"], ["shot.PNG", "*.png"]].map(([name, kind]) => isOfOverlayKind(name!, kind!)), [true, true, true], "a file matches its kind in any case");
  assert.deepEqual([["evil.md.js", "*.md"], [".md", "*.md"], ["readme", "*.md"], ["notesmd", "*.md"]].map(([name, kind]) => isOfOverlayKind(name!, kind!)), [false, false, false, false], "near-misses never match");
  for (const bad of [[], ["*"], ["*.md/x"], ["dir/Makefile"], ["*.*"]]) assert.ok(overlay("target-only/", bad).length > 0, `${JSON.stringify(bad)}: not a list of kinds`);
  assert.deepEqual(overlay("target-only/", ["*.md", "*.md"]), ["/boundary/overlay/kinds"], "a kind listed twice");
  assert.deepEqual(overlay("target-only/", ["*.txt", "*.png"]), [], "a document and an image");
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
