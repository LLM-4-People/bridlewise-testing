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
import { parseReleaseArguments, readReleaseRecords, releaseRecordsText, runReleaseCli, writeReleaseRecords } from "../../../src/workflow/promotion/release-cli.ts";
import { memoryCredential } from "../../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../../src/workflow/forge/github.ts";
import { fakeGithub } from "../../forge/fake-github.ts";
import { creditedName, creditedPeople, decisionChanges, landedPullRequests, renderReleaseNotes } from "../../../src/workflow/promotion/release-notes.ts";
import { releaseSbom } from "../../../src/workflow/promotion/release-sbom.ts";
import { planRelease, type ReleasePlan, type ReleaseRecord, type ReleaseSettings } from "../../../src/workflow/promotion/release-train.ts";
import { escapeMarkdownText } from "../../../../shared/markup.ts";
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

function plan(fixture: PromotionFixture, options: Readonly<{ now?: Date; manual?: boolean; settings?: Partial<ReleaseSettings>; releases?: readonly ReleaseRecord[] | null }> = {}): ReleasePlan {
  return planRelease({
    repository: fixture.repository,
    settings: { ...SETTINGS, ...options.settings },
    profileDirectory: PROFILE_DIRECTORY,
    commandNames: new Set(Object.keys(fixture.commands)),
    now: options.now ?? new Date(),
    manual: options.manual ?? false,
    releases: options.releases === undefined ? [] : options.releases,
  });
}

/** The release tag the train creates: annotated (its time is the release RECORD's, never the tag's). */
function releaseTag(fixture: PromotionFixture, tag: string, commit: string): void {
  fixture.git(["tag", "-a", tag, "-m", `release ${tag}`, commit]);
}

/** A published release record as the forge lists it. */
const published = (tag: string, at: number): ReleaseRecord => ({ tag, draft: false, publishedAt: new Date(at).toISOString() });

/** A tracker item (the public record) on the source, `open` or `closed`. */
function record(fixture: PromotionFixture, id: string, state: "open" | "closed", type = "Task"): void {
  const closed = state === "closed" ? "resolution: completed\nclosed: 2026-10-21\n" : "";
  fixture.commit(SOURCE, { [`docs/trackers/items/${id}.md`]: `---\nschema: bridlewise-tracker-item/v1\nid: ${id}\ntype: ${type}\ntitle: The ${id.toLowerCase()} record\nstate: ${state}\n${closed}lane: floor\nopened: 2026-10-20\n---\n\nWhat ${id} tracks.\n` }, `${id} ${state}`);
}

function refusedWith(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof PromotionError && error.promotionCode === code);
}

test("the train: a product with no Projected-From is never released; a projection departs once, then waits for each unmet condition by name", () => {
  const fixture = promotionFixture("release-train");
  refusedWith("promotion_release_source_unproven", () => plan(fixture));
  const first = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  const departing = plan(fixture);
  assert.deepEqual([departing.due, departing.reasons, departing.tag, departing.prerelease, departing.previous, departing.product.commit, departing.product.source], [true, [], "v1.0.0", false, null, first, fixture.tip(SOURCE)]);

  const at = Date.parse("2026-10-20T12:00:00Z");
  releaseTag(fixture, "v1.0.0", first);
  const records = [published("v1.0.0", at), { tag: "v9.0.0", draft: true, publishedAt: null }];
  const released = plan(fixture, { now: new Date(at + 5 * HOUR), releases: records });
  assert.ok(released.previous !== null && released.previous.tag === "v1.0.0" && released.previous.source === fixture.tip(SOURCE));
  assert.deepEqual([released.lastPublishedAt, released.hoursSincePrevious], ["2026-10-20T12:00:00.000Z", 5], "the interval runs from the release record's own published_at; a draft is no publication");
  assert.deepEqual(released.reasons, ["version_released", "product_unchanged", "no_record_closed", "interval"], "5 hours after a release, a 24-hour interval waits");
  assert.deepEqual(plan(fixture, { now: new Date(at + 5 * HOUR), releases: null }).reasons, ["version_released", "product_unchanged", "no_record_closed", "releases_unread"], "records not read: the interval is unmeasured, never \"due\"");
  const later = new Date(at + 48 * HOUR);
  for (const [records, why] of [
    [[], "an empty list"],
    [[published("v0.9.0", at)], "a published record for another tag"],
    [[{ tag: "v1.0.0", draft: true, publishedAt: null }, { tag: "v1.0.0", draft: false, publishedAt: null }], "a draft, and a record with no publication time"],
  ] as const) {
    const waiting = plan(fixture, { now: later, releases: records });
    assert.ok(waiting.reasons.includes("releases_unread") && waiting.hoursSincePrevious === null, `${why}: no published record of v1.0.0, so the interval is unmeasured and nothing departs`);
  }
  assert.deepEqual(plan(fixture, { now: new Date(at + HOUR), releases: records }).reasons, ["version_released", "product_unchanged", "no_record_closed", "interval"]);

  record(fixture, "SHIP-THE-THING", "closed");
  project(fixture, { "assets/notes.txt": "a product change\n" });
  assert.deepEqual(plan(fixture, { now: new Date(at + 48 * HOUR), releases: records }).reasons, ["version_released"], "a changed product with the same declared version waits for the next version");

  project(fixture, { "package.json": manifest(fixture, "1.1.0") });
  assert.deepEqual(plan(fixture, { now: new Date(at + HOUR), releases: records }).reasons, ["interval"]);
  const next = plan(fixture, { now: new Date(at + 24 * HOUR), releases: records });
  assert.deepEqual([next.due, next.tag, next.hoursSincePrevious], [true, "v1.1.0", 24], "exactly the interval is enough");
  assert.deepEqual(plan(fixture, { now: new Date(at + 24 * HOUR), settings: { minIntervalHours: 0 }, releases: records }).reasons, []);
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
  releaseTag(fixture, "v2.0.0", released);
  fixture.git(["tag", "v10.0.0-on-main", fixture.tip(SOURCE)]);
  fixture.git(["tag", "v11.0.0", fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-m", "off every history"])]);
  project(fixture, { "package.json": manifest(fixture, "1.9.9") });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
  fixture.git(["tag", "vnext", released]);
  fixture.git(["tag", "v1.5.0-on-main-lightweight", fixture.tip(SOURCE)]);
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
  const firstNotes = renderReleaseNotes(fixture.repository, firstPlan, SETTINGS, "https://forge.example/owner/name");
  assert.match(firstNotes, /first release projected from `main`/u);
  assert.match(firstNotes, /https:\/\/example\.invalid\/prior-releases/u);
  assert.doesNotMatch(firstNotes, /Developer preview/u, "1.0.0 is no pre-release");
  releaseTag(fixture, "v1.0.0", first);

  fixture.commit(SOURCE, { "docs/decisions/D-90-a-decision.md": "# Decide the thing\n\nBody.\n" }, "Add a decision (#8)\n\nSigned-off-by: Ada Writer <ada@example.invalid>\nCo-authored-by: Bo Pair <bo@example.invalid>");
  fixture.commit(SOURCE, { "assets/near-miss.txt": "x\n" }, "Mention (#not-a-number) and (#12) mid-subject\n\nSigned-off-by: Dee Plain");
  fixture.commit(SOURCE, { "assets/addresses.txt": "x\n" }, "Addresses only\n\nSigned-off-by: bare@example.invalid\nCo-authored-by: 4242+octo-cat@users.noreply.github.com\nCo-authored-by: Paren Name (paren@example.invalid)");
  fixture.git(["checkout", "-q", "-b", "topic", SOURCE]);
  fixture.git(["commit", "-q", "--allow-empty", "-m", "topic work\n\nSigned-off-by: Cy Third <cy@example.invalid>"]);
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #9 from someone/topic\n\nShip the topic"]);
  project(fixture, { "package.json": manifest(fixture, "1.1.0") });
  const next = plan(fixture, { settings: { minIntervalHours: 0 } });
  const from = next.previous!.source;
  assert.deepEqual(landedPullRequests(fixture.repository, from, next.product.source), [{ number: 8, title: "Add a decision" }, { number: 9, title: "Ship the topic" }]);
  assert.deepEqual(decisionChanges(fixture.repository, from, next.product.source), [{ status: "added", path: "docs/decisions/D-90-a-decision.md", title: "Decide the thing" }]);
  assert.deepEqual(creditedPeople(fixture.repository, from, next.product.source), ["@octo-cat", "Ada Writer", "Bo Pair", "Cy Third", "Dee Plain", "Paren Name"], "a name, or a private address's login; a bare address credits nobody");
  const notes = renderReleaseNotes(fixture.repository, next, SETTINGS, "https://forge.example/owner/name");
  for (const expected of ["- Add a decision (#8)", "- Ship the topic (#9)", "added: [Decide the thing]", "@octo\\-cat, Ada Writer, Bo Pair, Cy Third, Dee Plain, Paren Name", "gh release verify v1.1.0 --repo owner/name", "compare/v1.0.0...v1.1.0"]) assert.ok(notes.includes(expected), `${expected}\n${notes}`);
  assert.doesNotMatch(notes, /@[A-Za-z0-9.-]+\.[a-z]{2,}|noreply/u, "no address is published, in any form a trailer can take");
  assert.equal(renderReleaseNotes(fixture.repository, next, SETTINGS, "https://forge.example/owner/name"), notes, "the same plan gives the same notes");
});

test("a product seeded with earlier previews: their tags are previous releases, and the first projected release reads no records across them", () => {
  const fixture = promotionFixture("release-seeded");
  releaseTag(fixture, "v0.0.3-preview", fixture.tip(TARGET));
  fixture.commit(SOURCE, { "docs/decisions/D-91-older.md": "# Older\n" }, "An old change (#3)\n\nSigned-off-by: Old Author <old@example.invalid>");
  project(fixture, { "package.json": manifest(fixture, "0.1.0") });
  const seeded = plan(fixture, { settings: { minIntervalHours: 0 } });
  assert.deepEqual([seeded.due, seeded.previous?.tag, seeded.previous?.source, seeded.productChanged], [true, "v0.0.3-preview", null, true]);
  const fresh = plan(fixture, { now: new Date(Date.parse(fixture.git(["log", "-1", "--format=%cI", "v0.0.3-preview"])) + HOUR) });
  assert.deepEqual([fresh.lastPublishedAt, fresh.hoursSincePrevious, fresh.reasons], [null, null, []], "no release record here (the previews' records stay in the archived repository): no tag's or commit's date is ever taken for one");
  const notes = renderReleaseNotes(fixture.repository, seeded, SETTINGS, "https://forge.example/owner/name");
  assert.match(notes, /first release projected from `main`/u);
  assert.match(notes, /\[v0\.0\.3-preview\]\(https:\/\/forge\.example\/owner\/name\/releases\/tag\/v0\.0\.3-preview\), predates the projection/u);
  for (const absent of ["An old change", "Old Author", "## Landed", "## Decisions"]) assert.ok(!notes.includes(absent), `${absent}: no history is read across a seeded preview`);
  project(fixture, { "package.json": manifest(fixture, "0.0.2") });
  refusedWith("promotion_release_version_invalid", () => plan(fixture));
});

test("a public record must have closed since the last release: open, reopened and earlier closures do not count; the notes list what closed", () => {
  const fixture = promotionFixture("release-records");
  record(fixture, "EARLIER", "closed");
  record(fixture, "STILL-OPEN", "open");
  const first = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  const opening = plan(fixture);
  assert.deepEqual([opening.due, opening.closedRecords], [true, null], "the first projected release has no range to read closures from");
  releaseTag(fixture, "v1.0.0", first);
  const records = [published("v1.0.0", Date.parse("2026-10-01T00:00:00Z"))];
  record(fixture, "BOUNCED", "closed");
  record(fixture, "BOUNCED", "open");
  project(fixture, { "package.json": manifest(fixture, "1.1.0") });
  const waiting = plan(fixture, { releases: records });
  assert.deepEqual([waiting.reasons, waiting.closedRecords], [["no_record_closed"], []], "an item closed before the release, one still open, and one closed then reopened: none closed since");
  record(fixture, "STILL-OPEN", "closed");
  record(fixture, "A-FLAKE", "closed", "Flake");
  project(fixture, { "assets/next.txt": "next\n" });
  const due = plan(fixture, { releases: records });
  assert.deepEqual([due.due, due.closedRecords?.map((entry) => entry.id)], [true, ["A-FLAKE", "STILL-OPEN"]]);
  const notes = renderReleaseNotes(fixture.repository, due, SETTINGS, "https://forge.example/owner/name");
  assert.ok(notes.includes("## Closed\n\n- Flake: The a\\-flake record (`A-FLAKE`)\n- Task: The still\\-open record (`STILL-OPEN`)\n"), notes);
});

test("every text a record carries reaches the notes through the markup owner: a planted title, pull request title and name cannot inject Markdown or HTML", () => {
  const fixture = promotionFixture("release-markup");
  const first = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  releaseTag(fixture, "v1.0.0", first);
  const evil = "<script>alert(1)</script> [x](javascript:alert(1)) _b_";
  fixture.commit(SOURCE, { "docs/trackers/items/EVIL.md": `---\nschema: bridlewise-tracker-item/v1\nid: EVIL\ntype: Task\ntitle: ${evil}\nstate: closed\nresolution: completed\nlane: floor\nopened: 2026-10-20\nclosed: 2026-10-21\n---\n\nA planted title.\n` }, `${evil} **bold** (#7)\n\nSigned-off-by: <img src=x onerror=alert(1)> Name`);
  project(fixture, { "package.json": manifest(fixture, "1.1.0") });
  const notes = renderReleaseNotes(fixture.repository, plan(fixture, { releases: [published("v1.0.0", Date.now() - 48 * HOUR)] }), SETTINGS, "https://forge.example/owner/name");
  for (const raw of ["<script>", "](javascript", "_b_", "**bold**", "<img"]) assert.ok(!notes.includes(raw), `${raw} reached the notes raw:\n${notes}`);
  assert.ok(notes.includes(`- Task: ${escapeMarkdownText(evil)} (\`EVIL\`)`), `the closed record's title went through the owner:\n${notes}`);
  assert.ok(notes.includes(`- ${escapeMarkdownText(`${evil} **bold**`)} (#7)`), `the pull request title went through the owner:\n${notes}`);
});

test("a lightweight release tag on the product's line is refused, whatever its age; one on a main commit is no release", () => {
  const fixture = promotionFixture("release-lightweight");
  const first = project(fixture, { "package.json": manifest(fixture, "1.0.0") });
  fixture.git(["tag", "v1.0.0-rc.1", fixture.tip(SOURCE)]);
  assert.equal(plan(fixture).due, true, "a lightweight tag on a main commit the product only carries as a parent is not a release tag");
  fixture.git(["tag", "v1.0.0", first]);
  refusedWith("promotion_release_tag_lightweight", () => plan(fixture, { releases: [published("v1.0.0", Date.now() - 2 * HOUR)] }));
  fixture.git(["tag", "-d", "v1.0.0"]);
  releaseTag(fixture, "v1.0.0", first);
  assert.deepEqual(plan(fixture, { releases: [published("v1.0.0", Date.now() - 2 * HOUR)] }).reasons, ["version_released", "product_unchanged", "no_record_closed", "interval"], "the same release, tagged annotated, is read, and its record's time keeps the interval");
});

test("the release records file: one forge record per line, any other shape refused", () => {
  const directory = createTempDir("release-records-");
  const write = (text: string): string => (writeFileSync(join(directory, "records.jsonl"), text), join(directory, "records.jsonl"));
  assert.deepEqual(readReleaseRecords(write('{"tag_name":"v1.0.0","draft":false,"published_at":"2026-10-20T12:00:00Z"}\n\n{"tag_name":"v1.1.0","draft":true,"published_at":null}\n')), [
    { tag: "v1.0.0", draft: false, publishedAt: "2026-10-20T12:00:00Z" },
    { tag: "v1.1.0", draft: true, publishedAt: null },
  ]);
  assert.deepEqual(readReleaseRecords(write("")), [], "no release yet");
  for (const bad of ["not json", '{"tag_name":"v1"}', '{"tag_name":"v1","draft":"no","published_at":null}', '{"tag_name":"v1","draft":false,"published_at":"yesterday"}']) {
    assert.throws(() => readReleaseRecords(write(`${bad}\n`)), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_usage", bad);
  }
  assert.throws(() => readReleaseRecords(join(directory, "absent.jsonl")), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_usage");
});

test("records: every release of the trunk, read page by page through the forge as the publisher, written as the file the other verbs read", async () => {
  const fake = fakeGithub();
  const releases = Array.from({ length: 150 }, (_, index) => ({ tag_name: `v0.${String(149 - index)}.0`, draft: index === 0, published_at: index === 0 ? null : new Date(Date.UTC(2026, 0, 1) + (149 - index) * HOUR).toISOString(), name: null, prerelease: false, html_url: `https://forge.example/o/r/releases/${String(index)}` }));
  fake.objects.set("/repos/o/r/releases", releases);
  const forge = { client: githubClient(fake.endpoint(), memoryCredential("app:bridlewise-publisher", fake.userToken("publisher"))), repository: "o/r" };
  const out = join(createTempDir("release-records-forge-"), "records.jsonl");
  const written = await writeReleaseRecords({ forge, maxPages: 5, out });
  assert.equal(written.code, "promotion_release_records_written");
  assert.equal((written.data as { records: number }).records, 150);
  assert.deepEqual(fake.requests.filter((request) => request.path === "/repos/o/r/releases").map((request) => [request.query.get("per_page"), request.query.get("page")]), [["100", null], ["100", "2"]], "every page, 100 at a time");
  const read = readReleaseRecords(out);
  assert.deepEqual(read, releases.map((release) => ({ tag: release.tag_name, draft: release.draft, publishedAt: release.published_at })), "the forge's records, in its order, read back exactly");
  assert.equal(releaseRecordsText(read), readFileSync(out, "utf8"), "one writer of the format");
  // A list longer than the bound is refused, never truncated; a forge failure keeps its class; neither leaves a file.
  const bounded = join(createTempDir("release-records-bounded-"), "records.jsonl");
  const refusedAs = (code: string) => (error: unknown): boolean => error instanceof PromotionError && error.promotionCode === code;
  await assert.rejects(() => writeReleaseRecords({ forge, maxPages: 1, out: bounded }), refusedAs("promotion_forge_refused"));
  fake.refuseNext({ method: "GET", path: /\/releases$/u }, { status: 503, message: "unavailable" });
  await assert.rejects(() => writeReleaseRecords({ forge, maxPages: 5, out: bounded }), refusedAs("promotion_forge_errored"));
  assert.throws(() => readFileSync(bounded), "nothing was written");
});

/** An npm integrity of `text`'s bytes. */
const integrity = (text: string): string => `sha512-${createHash("sha512").update(text).digest("base64")}`;

test("the SBOM: SPDX 2.3 of exactly the product commit's own lockfiles — every installed package, its purl, checksum, licence and how it is depended on; deterministic", () => {
  const fixture = promotionFixture("release-sbom");
  const rootLock = { name: "fixture", lockfileVersion: 3, requires: true, packages: {
    "": { name: "fixture", version: "1.0.0", license: "AGPL-3.0-only" },
    "node_modules/zod": { version: "1.0.0", resolved: "https://registry.npmjs.org/zod/-/zod-1.0.0.tgz", integrity: integrity("zod"), license: "MIT" },
    "node_modules/@scope/kit": { version: "2.1.0", resolved: "https://registry.npmjs.org/@scope/kit/-/kit-2.1.0.tgz", integrity: integrity("kit"), license: "(MIT OR Apache-2.0)" },
    "node_modules/vite": { version: "1.0.0", integrity: integrity("vite"), dev: true, license: "SEE LICENSE IN LICENSE.md" },
    "node_modules/fsevents": { version: "2.3.3", integrity: integrity("fsevents"), optional: true, license: "UNLICENSED" },
    "node_modules/vite/node_modules/zod": { version: "0.9.0", integrity: integrity("old zod"), dev: true },
    "node_modules/local": { resolved: "packages/local", link: true },
    "packages/local": { name: "local", version: "0.0.1" },
  } };
  const engineLock = { name: "engine", lockfileVersion: 3, requires: true, packages: {
    "": { name: "engine", version: "1.0.0" },
    "node_modules/zod": { version: "1.0.0", resolved: "https://registry.npmjs.org/zod/-/zod-1.0.0.tgz", integrity: integrity("zod"), license: "MIT" },
  } };
  const commit = project(fixture, { "package.json": manifest(fixture, "1.0.0"), "package-lock.json": json(rootLock), "engine/package-lock.json": json(engineLock) });
  const due = plan(fixture);
  assert.equal(due.due, true);
  const text = releaseSbom(fixture.repository, due);
  assert.equal(releaseSbom(fixture.repository, due), text, "the same commit gives the same bytes");
  const sbom = JSON.parse(text) as { spdxVersion: string; dataLicense: string; SPDXID: string; name: string; documentNamespace: string; creationInfo: { created: string; creators: string[] };
    packages: { SPDXID: string; name: string; versionInfo: string; downloadLocation: string; licenseDeclared: string; checksums?: { algorithm: string; checksumValue: string }[]; externalRefs?: { referenceLocator: string }[] }[];
    relationships: { spdxElementId: string; relationshipType: string; relatedSpdxElement: string }[] };
  assert.deepEqual([sbom.spdxVersion, sbom.dataLicense, sbom.SPDXID, sbom.name], ["SPDX-2.3", "CC0-1.0", "SPDXRef-DOCUMENT", "bridlewise-1.0.0"]);
  assert.equal(sbom.documentNamespace, `https://spdx.org/spdxdocs/bridlewise-1.0.0-${commit}`);
  assert.equal(sbom.creationInfo.created, new Date(Number(fixture.git(["show", "-s", "--format=%ct", commit])) * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z"), "the commit's time, not the clock");
  const byName = (name: string, version: string) => sbom.packages.find((entry) => entry.name === name && entry.versionInfo === version)!;
  assert.deepEqual(sbom.packages.map((entry) => `${entry.name}@${entry.versionInfo}`).sort(), ["@scope/kit@2.1.0", "engine@1.0.0", "fixture@1.0.0", "fsevents@2.3.3", "vite@1.0.0", "zod@0.9.0", "zod@1.0.0"], "every installed package once, the roots, and no workspace link");
  assert.deepEqual(byName("@scope/kit", "2.1.0").externalRefs!.map((ref) => ref.referenceLocator), ["pkg:npm/%40scope/kit@2.1.0"]);
  assert.deepEqual(byName("zod", "1.0.0").checksums, [{ algorithm: "SHA512", checksumValue: createHash("sha512").update("zod").digest("hex") }]);
  assert.equal(byName("zod", "1.0.0").downloadLocation, "https://registry.npmjs.org/zod/-/zod-1.0.0.tgz");
  assert.equal(byName("vite", "1.0.0").downloadLocation, "NOASSERTION");
  assert.deepEqual(["zod@1.0.0", "@scope/kit@2.1.0", "vite@1.0.0", "fsevents@2.3.3", "fixture@1.0.0"].map((key) => byName(key.slice(0, key.lastIndexOf("@")), key.slice(key.lastIndexOf("@") + 1)).licenseDeclared), ["MIT", "(MIT OR Apache-2.0)", "NOASSERTION", "NOASSERTION", "AGPL-3.0-only"], "a licence is an SPDX expression or NOASSERTION, never guessed");
  const ids = new Set(sbom.packages.map((entry) => entry.SPDXID));
  assert.equal(ids.size, sbom.packages.length, "unique element ids");
  for (const relationship of sbom.relationships) assert.ok((relationship.spdxElementId === "SPDXRef-DOCUMENT" || ids.has(relationship.spdxElementId)) && ids.has(relationship.relatedSpdxElement), JSON.stringify(relationship));
  const rel = (name: string, version: string, root: string) => sbom.relationships.filter((relationship) => relationship.spdxElementId === byName(name, version).SPDXID && relationship.relatedSpdxElement === byName(root, "1.0.0").SPDXID).map((relationship) => relationship.relationshipType);
  assert.deepEqual([rel("zod", "1.0.0", "fixture"), rel("zod", "1.0.0", "engine"), rel("vite", "1.0.0", "fixture"), rel("fsevents", "2.3.3", "fixture"), rel("zod", "0.9.0", "fixture")], [["DEPENDENCY_OF"], ["DEPENDENCY_OF"], ["DEV_DEPENDENCY_OF"], ["OPTIONAL_DEPENDENCY_OF"], ["DEV_DEPENDENCY_OF"]]);
  assert.deepEqual(sbom.relationships.filter((relationship) => relationship.relationshipType === "DESCRIBES").map((relationship) => relationship.relatedSpdxElement).sort(), [byName("engine", "1.0.0").SPDXID, byName("fixture", "1.0.0").SPDXID].sort(), "the document describes each lockfile's root");
});

test("the SBOM fails closed: a lockfile it cannot read exactly is refused by name, never described in part", () => {
  const refusedSbom = (lock: unknown, extra: Readonly<Record<string, string | null>> = {}): void => {
    const fixture = promotionFixture("release-sbom-refused");
    project(fixture, { "package.json": manifest(fixture, "1.0.0"), "package-lock.json": lock === null ? null : json(lock), ...extra });
    const due = plan(fixture);
    assert.throws(() => releaseSbom(fixture.repository, due), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_sbom_lockfile_invalid", JSON.stringify(lock).slice(0, 80));
  };
  const root = { "": { name: "fixture", version: "1.0.0" } };
  refusedSbom({ lockfileVersion: 1, dependencies: {} });
  refusedSbom({ lockfileVersion: 4, packages: { "": { name: "fixture", version: "1.0.0" } } });
  refusedSbom({ lockfileVersion: 3, packages: { "": { name: "fixture" } } });
  refusedSbom({ lockfileVersion: 3, packages: { ...root, "node_modules/zod": { resolved: "x" } } });
  refusedSbom({ lockfileVersion: 3, packages: { ...root, "node_modules/zod": { version: "1.0.0", integrity: "md5-AAAA" } } });
  refusedSbom({ lockfileVersion: 3, packages: { ...root, "node_modules/zod": { version: "1.0.0", integrity: 7 } } });
  refusedSbom(null);
  refusedSbom({ lockfileVersion: 3, packages: root }, { "engine/package-lock.json": "{ not json" });
});

test("a credited value never publishes an address", () => {
  const cases: ReadonlyArray<readonly [string, string | null]> = [
    ["Ada Writer <ada@example.invalid>", "Ada Writer"],
    ["ada@example.invalid", null],
    ["<ada@example.invalid>", null],
    ["Ada (ada@example.invalid)", "Ada"],
    ["12+octo@users.noreply.github.com", "@octo"],
    ["octo@users.noreply.github.com", "@octo"],
    ["Octo Cat <12+octo@users.noreply.github.com>", "Octo Cat"],
    ["evil@users.noreply.github.com.example.invalid", null],
    ["Plain Name", "Plain Name"],
    ["", null],
  ];
  for (const [value, expected] of cases) assert.equal(creditedName(value), expected, value);
});

test("the assets: every input required, canonical names, the source archive of the product commit, and checksums that verify", () => {
  const fixture = promotionFixture("release-assets");
  project(fixture, { "package.json": manifest(fixture, "0.2.0") });
  const releasePlan = plan(fixture);
  const inputs = createTempDir("release-inputs-");
  const write = (name: string, content: string): string => (writeFileSync(join(inputs, name), content), join(inputs, name));
  const all = { bundle: write("engine.js", "export {};\n"), guardian: write("guardian", "\x7fELF"), sbom: write("sbom.json", json({ spdxVersion: "SPDX-2.3", packages: [] })), docsSite: write("site.tar.gz", "site") };

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
  for (const argv of [["records"], ["records", "--releases", "r", "--out", "x"], ["sbom", "--out", "x"], ["sbom", "--releases", "r"], ["sbom", "--releases", "r", "--out", "x", "--repository", "https://forge.example/o/r"], [], ["publish"], ["plan", "--out", "x"], ["notes", "--out", "x"], ["notes", "--releases", "r", "--repository", "owner/name", "--out", "x"], ["notes", "--releases", "r", "--repository", "http://forge.example/owner/name", "--out", "x"], ["plan", "--releases", "r", "--now", "yesterday"], ["assemble", "--out", "x"], ["plan", "--now"]]) {
    assert.throws(() => parseReleaseArguments(argv), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_usage", argv.join(" "));
  }
  assert.equal(parseReleaseArguments(["plan", "--releases", "r.jsonl", "--manual", "--now", "2026-10-21T00:00:00Z"]).manual, true);
  assert.throws(() => parseReleaseArguments(["plan"]), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_release_usage", "the records are required");
  const none = join(createTempDir("release-door-records-"), "records.jsonl");
  writeFileSync(none, "");

  const fixture = promotionFixture("release-door");
  const withRelease = { ...fixture.document, promotion: { ...fixture.document.promotion!, release: SETTINGS } } as Pick<ConfigDocument, "workspaceIsolation" | "promotion" | "workspaceGit" | "harness" | "resourceLock">;
  assert.equal((await runReleaseCli(fixture.root, ["plan", "--releases", none], fixture.document)).result.result.code, "promotion_release_settings_missing");
  const released = project(fixture, { "package.json": manifest(fixture, "1.0.0"), "package-lock.json": json({ name: "fixture", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" }, "node_modules/zod": { version: "1.0.0", integrity: integrity("zod") } } }) });
  const notesOut = join(createTempDir("release-door-"), "notes.md");
  const due = await runReleaseCli(fixture.root, ["notes", "--releases", none, "--repository", "https://forge.example/owner/name", "--out", notesOut], withRelease);
  assert.deepEqual([due.result.result.code, due.exitCode], ["promotion_release_notes_written", 0]);
  assert.match(readFileSync(notesOut, "utf8"), /gh release verify v1\.0\.0/u);
  const sbomOut = join(createTempDir("release-door-sbom-"), "sbom.spdx.json");
  const sbom = await runReleaseCli(fixture.root, ["sbom", "--releases", none, "--out", sbomOut], withRelease);
  assert.deepEqual([sbom.result.result.code, sbom.exitCode], ["promotion_release_sbom_written", 0]);
  assert.equal((JSON.parse(readFileSync(sbomOut, "utf8")) as { spdxVersion: string }).spdxVersion, "SPDX-2.3");
  releaseTag(fixture, "v1.0.0", released);
  const waitingSbom = join(createTempDir("release-door-sbom-waiting-"), "sbom.spdx.json");
  assert.equal((await runReleaseCli(fixture.root, ["sbom", "--releases", none, "--out", waitingSbom], withRelease)).result.result.code, "promotion_release_not_due");
  assert.throws(() => readFileSync(waitingSbom), "a waiting train writes no SBOM");
  const waiting = await runReleaseCli(fixture.root, ["assemble", "--releases", none, "--out", join(createTempDir("release-door-out-"), "x"), "--bundle", "a", "--guardian", "b", "--sbom", "c", "--docs-site", "d"], withRelease);
  assert.deepEqual([waiting.result.result.code, waiting.exitCode], ["promotion_release_not_due", 0], "a waiting train assembles nothing");
  assert.match(waiting.text!(), /declare the next version/u);
});
