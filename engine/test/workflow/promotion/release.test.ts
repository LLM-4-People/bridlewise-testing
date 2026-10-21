/**
 * THE RELEASE TRAIN (github-only §9.4): when the product departs and as which
 * version (`release-train.ts`), the notes generated from the records between
 * two releases (`release-notes.ts`), the assets and their checksums
 * (`release-assets.ts`), and the door (`release-cli.ts`). Over the promotion
 * fixture: `dev` is the source, `prod` the product, each product commit a
 * projection of a `dev` commit (its `Projected-From` trailer).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { ConfigDocument } from "../../../src/kernel/config-contracts.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { assembleRelease, releaseAssetNames } from "../../../src/workflow/promotion/release-assets.ts";
import { parseReleaseArguments, runReleaseCli } from "../../../src/workflow/promotion/release-cli.ts";
import { creditedPeople, decisionChanges, landedPullRequests, renderReleaseNotes } from "../../../src/workflow/promotion/release-notes.ts";
import { compareSemver, parseSemver, planRelease, type ReleasePlan, type ReleaseSettings } from "../../../src/workflow/promotion/release-train.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { PROFILE_DIRECTORY, PROFILE_NAME, SOURCE, TARGET, json, promotionFixture, type PromotionFixture } from "./promotion-fixture.ts";

const SETTINGS: ReleaseSettings = { profile: PROFILE_NAME, train: "auto", minIntervalHours: 24, tagPrefix: "v", discussionCategory: "Releases", priorReleasesUrl: "https://example.invalid/prior-releases" };
const HOUR = 3_600_000;

/** The product's manifest as the fixture made it, with `version`. */
function manifest(fixture: PromotionFixture, version: unknown): string {
  const initial = fixture.git(["rev-list", "--max-parents=0", TARGET]).split("\n")[0]!;
  return json({ ...(JSON.parse(fixture.git(["show", `${initial}:package.json`])) as Record<string, unknown>), version });
}

/** A projection of dev's tip onto prod (parents [prod, dev], the trailers a promotion writes), with `files` changed on the product. */
function project(fixture: PromotionFixture, files: Readonly<Record<string, string | null>>): string {
  const parent = fixture.tip(TARGET);
  const changed = fixture.commit(TARGET, files, "the product's next tree");
  const source = fixture.tip(SOURCE);
  const commit = fixture.git(["commit-tree", fixture.git(["rev-parse", `${changed}^{tree}`]), "-p", parent, "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: ${PROFILE_NAME}@0000000`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, commit]);
  // The train is asked from a checkout of the source (it reads the product's profile at HEAD).
  fixture.git(["checkout", "-q", SOURCE]);
  return commit;
}

function plan(fixture: PromotionFixture, options: Readonly<{ now?: Date; manual?: boolean; settings?: Partial<ReleaseSettings> }> = {}): ReleasePlan {
  return planRelease({
    repository: fixture.repository,
    settings: { ...SETTINGS, ...options.settings },
    profileDirectory: PROFILE_DIRECTORY,
    commandNames: new Set(Object.keys(fixture.commands)),
    now: options.now ?? new Date(),
    manual: options.manual ?? false,
  });
}

function refusedWith(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof PromotionError && error.promotionCode === code);
}

test("semantic versions: precedence as semver.org §11 orders it, and only full versions parse", () => {
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(compareSemver(parseSemver(ordered[index - 1]!)!, parseSemver(ordered[index]!)!) < 0, `${ordered[index - 1]!} < ${ordered[index]!}`);
    assert.ok(compareSemver(parseSemver(ordered[index]!)!, parseSemver(ordered[index - 1]!)!) > 0);
  }
  assert.equal(compareSemver(parseSemver("0.10.0")!, parseSemver("0.9.0")!) > 0, true, "numeric, never lexical");
  for (const invalid of ["1.0", "v1.0.0", "01.0.0", "1.0.0+build", "1.0.0-", ""]) assert.equal(parseSemver(invalid), null, invalid);
});

test("the train: a product with no Projected-From is never released; a projection departs once, then waits for each unmet condition by name", () => {
  const fixture = promotionFixture("release-train");
  refusedWith("promotion_release_source_unproven", () => plan(fixture));
  const first = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  const departing = plan(fixture);
  assert.deepEqual([departing.due, departing.reasons, departing.tag, departing.prerelease, departing.previous, departing.product.commit, departing.product.source], [true, [], "v1.0.0", false, null, first, fixture.tip(SOURCE)]);

  fixture.git(["tag", "v1.0.0", first]);
  const released = plan(fixture);
  assert.ok(released.previous !== null && released.previous.tag === "v1.0.0" && released.previous.source === fixture.tip(SOURCE));
  const at = Date.parse(released.previous.at);
  assert.deepEqual(plan(fixture, { now: new Date(at + HOUR) }).reasons, ["version_released", "product_unchanged", "interval"]);

  project(fixture, { "assets/notes.txt": "a product change\n" });
  assert.deepEqual(plan(fixture, { now: new Date(at + 48 * HOUR) }).reasons, ["version_released"], "a changed product with the same declared version waits for the next version");

  project(fixture, { "package.json": manifest(fixture, "1.1.0") });
  assert.deepEqual(plan(fixture, { now: new Date(at + HOUR) }).reasons, ["interval"]);
  const next = plan(fixture, { now: new Date(at + 24 * HOUR) });
  assert.deepEqual([next.due, next.tag, next.hoursSincePrevious], [true, "v1.1.0", 24], "exactly the interval is enough");
  assert.deepEqual(plan(fixture, { now: new Date(at + 24 * HOUR), settings: { minIntervalHours: 0 } }).reasons, []);
});

test("the train's modes: manual departs only when a person asks, approval departs through a reviewer", () => {
  const fixture = promotionFixture("release-modes");
  project(fixture, { "package.json": manifest(fixture, "0.3.0-preview.1") });
  assert.deepEqual(plan(fixture, { settings: { train: "manual" } }).reasons, ["manual_mode"]);
  assert.equal(plan(fixture, { settings: { train: "manual" }, manual: true }).due, true);
  const approval = plan(fixture, { settings: { train: "approval" } });
  assert.deepEqual([approval.due, approval.approval, approval.prerelease], [true, true, true], "below 1.0 and a pre-release part both publish a pre-release");
});

test("the version: a manifest with no semantic version, or one below the last release, is refused", () => {
  const fixture = promotionFixture("release-version");
  project(fixture, { "package.json": manifest(fixture, "1.0") });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
  project(fixture, { "package.json": manifest(fixture, null) });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
  project(fixture, { "package.json": "{ not json" });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
  const released = project(fixture, { "package.json": manifest(fixture, "2.0.0") });
  fixture.git(["tag", "v2.0.0", released]);
  fixture.git(["tag", "v10.0.0-on-main", fixture.tip(SOURCE)]);
  fixture.git(["tag", "v11.0.0", fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-m", "off every history"])]);
  project(fixture, { "package.json": manifest(fixture, "1.9.9") });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
  fixture.git(["tag", "vnext", released]);
  project(fixture, { "package.json": manifest(fixture, "2.0.1") });
  assert.equal(plan(fixture, { settings: { minIntervalHours: 0 } }).previous?.tag, "v2.0.0", "a tag on a main commit the product carries, one off every history, and one that names no version are not releases");
});

test("the product ref missing is a typed refusal naming it", () => {
  const fixture = promotionFixture("release-missing");
  fixture.git(["branch", "-D", TARGET]);
  refusedWith("promotion_release_product_missing", () => plan(fixture));
});

test("the notes: landed pull requests, decision records and credited names between two releases' sources; the first release names the prior ones; never an address", () => {
  const fixture = promotionFixture("release-notes");
  const first = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  const firstPlan = plan(fixture);
  const firstNotes = renderReleaseNotes(fixture.repository, firstPlan, SETTINGS, "owner/name");
  assert.match(firstNotes, /first release projected from `main`/u);
  assert.match(firstNotes, /https:\/\/example\.invalid\/prior-releases/u);
  assert.doesNotMatch(firstNotes, /Developer preview/u, "1.0.0 is no pre-release");
  fixture.git(["tag", "v1.0.0", first]);

  fixture.commit(SOURCE, { "docs/decisions/D-90-a-decision.md": "# Decide the thing\n\nBody.\n" }, "Add a decision (#8)\n\nSigned-off-by: Ada Writer <ada@example.invalid>\nCo-authored-by: Bo Pair <bo@example.invalid>");
  fixture.commit(SOURCE, { "assets/near-miss.txt": "x\n" }, "Mention (#not-a-number) and (#12) mid-subject\n\nSigned-off-by: Dee Plain");
  fixture.git(["checkout", "-q", "-b", "topic", SOURCE]);
  fixture.git(["commit", "-q", "--allow-empty", "-m", "topic work\n\nSigned-off-by: Cy Third <cy@example.invalid>"]);
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #9 from someone/topic\n\nShip the topic"]);
  project(fixture, { "package.json": manifest(fixture, "1.1.0") });
  const next = plan(fixture, { settings: { minIntervalHours: 0 } });
  const from = next.previous!.source;
  assert.deepEqual(landedPullRequests(fixture.repository, from, next.product.source), [{ number: 8, title: "Add a decision" }, { number: 9, title: "Ship the topic" }]);
  assert.deepEqual(decisionChanges(fixture.repository, from, next.product.source), [{ status: "added", path: "docs/decisions/D-90-a-decision.md", title: "Decide the thing" }]);
  assert.deepEqual(creditedPeople(fixture.repository, from, next.product.source), ["Ada Writer", "Bo Pair", "Cy Third", "Dee Plain"], "a value naming no address is a name as it stands");
  const notes = renderReleaseNotes(fixture.repository, next, SETTINGS, "owner/name");
  for (const expected of ["- Add a decision (#8)", "- Ship the topic (#9)", "added: [Decide the thing]", "Ada Writer, Bo Pair, Cy Third, Dee Plain", "gh release verify v1.1.0 --repo owner/name", "compare/v1.0.0...v1.1.0"]) assert.ok(notes.includes(expected), `${expected}\n${notes}`);
  assert.doesNotMatch(notes, /example\.invalid/u, "no address is published");
  assert.equal(renderReleaseNotes(fixture.repository, next, SETTINGS, "owner/name"), notes, "the same plan gives the same notes");
});

test("a product seeded with earlier previews: their tags are previous releases, and the first projected release reads no records across them", () => {
  const fixture = promotionFixture("release-seeded");
  fixture.git(["tag", "v0.0.3-preview", fixture.tip(TARGET)]);
  fixture.commit(SOURCE, { "docs/decisions/D-91-older.md": "# Older\n" }, "An old change (#3)\n\nSigned-off-by: Old Author <old@example.invalid>");
  project(fixture, { "package.json": manifest(fixture, "0.1.0") });
  const seeded = plan(fixture, { settings: { minIntervalHours: 0 } });
  assert.deepEqual([seeded.due, seeded.previous?.tag, seeded.previous?.source, seeded.productChanged], [true, "v0.0.3-preview", null, true]);
  const notes = renderReleaseNotes(fixture.repository, seeded, SETTINGS, "owner/name");
  assert.match(notes, /first release projected from `main`/u);
  assert.match(notes, /\[v0\.0\.3-preview\]\(https:\/\/github\.com\/owner\/name\/releases\/tag\/v0\.0\.3-preview\), predates the projection/u);
  for (const absent of ["An old change", "Old Author", "## Landed", "## Decisions"]) assert.ok(!notes.includes(absent), `${absent}: no history is read across a seeded preview`);
  project(fixture, { "package.json": manifest(fixture, "0.0.2") });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
});

test("the assets: every input required, canonical names, the source archive of the product commit, and checksums that verify", () => {
  const fixture = promotionFixture("release-assets");
  project(fixture, { "package.json": manifest(fixture, "0.2.0") });
  const releasePlan = plan(fixture);
  const inputs = createTempDir("release-inputs-");
  const write = (name: string, content: string): string => (writeFileSync(join(inputs, name), content), join(inputs, name));
  const all = { bundle: write("bundle.js", "export {};\n"), guardian: write("guardian", "\x7fELF"), sbom: write("sbom.json", json({ spdxVersion: "SPDX-2.3", packages: [] })), docsSite: write("site.tar.gz", "site") };

  const missing = createTempDir("release-out-missing-");
  assert.throws(() => assembleRelease({ repository: fixture.repository, plan: releasePlan, out: missing, inputs: { bundle: all.bundle, sbom: all.sbom, docsSite: write("empty", "") }, platform: "linux-x64" }), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_assets_incomplete" && JSON.stringify(error.facts["missing"]) === JSON.stringify(["guardian", "docsSite"]));
  assert.throws(() => assembleRelease({ repository: fixture.repository, plan: releasePlan, out: missing, inputs: { ...all, sbom: write("not-spdx.json", json({ bomFormat: "CycloneDX" })) }, platform: "linux-x64" }), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_assets_incomplete");

  const out = join(createTempDir("release-out-"), "assets");
  const assets = assembleRelease({ repository: fixture.repository, plan: releasePlan, out, inputs: all, platform: "linux-x64" });
  const names = releaseAssetNames("0.2.0", "linux-x64");
  assert.deepEqual(assets.map((asset) => asset.name), [names.source, names.bundle, names.docsSite, names.guardian, names.sbom].sort().concat(names.checksums));
  for (const asset of assets) assert.equal(createHash("sha256").update(readFileSync(join(out, asset.name))).digest("hex"), asset.sha256, asset.name);
  const sums = readFileSync(join(out, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.deepEqual(sums, assets.slice(0, -1).map((asset) => `${asset.sha256}  ${asset.name}`));
  const listed = execFileSync("tar", ["tzf", join(out, names.source)], { encoding: "utf8" }).split("\n");
  assert.ok(listed.includes("bridlewise-0.2.0/package.json") && listed.every((path) => path === "" || path.startsWith("bridlewise-0.2.0/")), "the product commit's tree under one prefix");
  assert.throws(() => assembleRelease({ repository: fixture.repository, plan: releasePlan, out, inputs: all, platform: "linux-x64" }), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_usage", "never over an earlier assembly");
});

test("the door: its grammar refuses typed, and a due plan writes the notes while a waiting one builds nothing", async () => {
  for (const argv of [[], ["publish"], ["plan", "--out", "x"], ["notes", "--out", "x"], ["notes", "--repository", "not a slug", "--out", "x"], ["plan", "--now", "yesterday"], ["assemble", "--out", "x"], ["plan", "--now"]]) {
    assert.throws(() => parseReleaseArguments(argv), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_usage", argv.join(" "));
  }
  assert.equal(parseReleaseArguments(["plan", "--manual", "--now", "2026-10-21T00:00:00Z"]).manual, true);

  const fixture = promotionFixture("release-door");
  const withRelease = { ...fixture.document, promotion: { ...fixture.document.promotion!, release: SETTINGS } } as Pick<ConfigDocument, "workspaceIsolation" | "promotion" | "workspaceGit" | "harness" | "resourceLock">;
  assert.equal((await runReleaseCli(fixture.root, ["plan"], fixture.document)).result.result.code, "promotion_release_settings_missing");
  const released = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  const notesOut = join(createTempDir("release-door-"), "notes.md");
  const due = await runReleaseCli(fixture.root, ["notes", "--repository", "owner/name", "--out", notesOut], withRelease);
  assert.deepEqual([due.result.result.code, due.exitCode], ["promotion_release_notes_written", 0]);
  assert.match(readFileSync(notesOut, "utf8"), /gh release verify v1\.0\.0/u);
  fixture.git(["tag", "v1.0.0", released]);
  const waiting = await runReleaseCli(fixture.root, ["assemble", "--out", join(createTempDir("release-door-out-"), "x"), "--bundle", "a", "--guardian", "b", "--sbom", "c", "--docs-site", "d"], withRelease);
  assert.deepEqual([waiting.result.result.code, waiting.exitCode], ["promotion_release_not_due", 0], "a waiting train assembles nothing");
  assert.match(waiting.text!(), /declare the next version/u);
});
