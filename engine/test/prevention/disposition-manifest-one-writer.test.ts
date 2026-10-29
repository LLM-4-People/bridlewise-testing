/**
 * ONE WRITER SIGNS EACH DISPOSITION RECORD, AND A STALE PIN REFUSES BY NAME.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * `harness regenerate` carried an inlined copy of the manifest logic. Its own
 * comment said why — importing the builder-layer verification module would put
 * `src/ -> scripts/` into the runtime import graph, which the architecture
 * forbids — and the constraint was real. The copy was not the only way to
 * satisfy it, and it differed from the original in two ways that mattered:
 *
 *   - it read the file with a raw `JSON.parse` and checked two fields by
 *     hand, so the schema never saw the entries;
 *   - it wrote `policyHash` from the CURRENT policy UNCONDITIONALLY.
 *
 * The second is the one with teeth. A stale `policyHash` means the manifest
 * records dispositions made under discovery rules that no longer apply — the
 * exact state a renamed test directory produces — and rewriting it makes the
 * pin agree with the new policy while describing the old world. It was the
 * only path in the repository that could re-bless a stale pin, and it made one
 * of the refusals that guard the test surface passable.
 *
 * The shared half now lives in the runtime layer where both callers may import
 * it, so there is one writer. This file holds the evidence that the
 * distinction the copy erased is now enforced: a stale SIGNATURE heals, a
 * stale POLICY refuses.
 *
 * The records now live one per decision (src/workflow/disposition-records.ts),
 * each carrying the policy hash it was decided under. Every plant is written
 * to a scratch copy of the records. No test writes to the live records.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  defaultDispositionEntry,
  dispositionRecordPath,
  parseDispositionRecord,
  serializeDispositionRecord,
  testSurfacePolicyHash,
} from "../../src/kernel/test-surface-manifest.ts";
import { dispositionRecordFiles, readDispositionManifest, rewriteDispositionRecords } from "../../src/workflow/disposition-records.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");
const RECORDS = ROOT_POLICY.verification.testDiscovery.dispositionRegistry.recordsPath;

/** A scratch engine root holding a copy of the live records — never the live ones. */
function scratchRecords(): string {
  const root = createTempDir("disposition-records-");
  cpSync(join(REPOSITORY_ROOT, RECORDS), join(root, RECORDS), { recursive: true });
  return root;
}

function writeRecord(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

test("the live records round-trip through the owner byte-for-byte, one record per decision, the exceptions only", () => {
  // LIVENESS on the whole mechanism, and the format contract: a record the writer would rewrite would be rewritten by
  // `harness regenerate` on every run, and every diff would be noise.
  const records = dispositionRecordFiles(REPOSITORY_ROOT);
  assert.ok(records.length > 0, "the exceptions are recorded");
  assert.deepEqual(rewriteDispositionRecords(REPOSITORY_ROOT, false), { status: "current", changed: [] });
  const manifest = readDispositionManifest(REPOSITORY_ROOT);
  assert.deepEqual(records.map((record) => record.path), manifest.entries.map((entry) => dispositionRecordPath(entry.path)), "one record per decision, at its source's own location");
  // A qualified Node test source is canonical without a record (#221): adding a test writes nothing here.
  assert.deepEqual(manifest.entries.filter((entry) => entry.disposition === "canonical-node-test" && entry.evidenceLinks.length === 0 && defaultDispositionEntry(entry.path) !== undefined).map((entry) => entry.path), []);
  for (const record of records) assert.doesNotMatch(record.text, /"(?:path|language|integrityHash)"/u, `${record.path}: the location and the language are derived, never written`);
});

test("a default decision written out by hand heals to what the one writer would have written", () => {
  const root = scratchRecords();
  // The plant: this very file, a qualified Node test source, written out as the canonical decision it takes by default.
  const self = "test/prevention/disposition-manifest-one-writer.test.ts";
  writeRecord(root, dispositionRecordPath(self), serializeDispositionRecord({ ...defaultDispositionEntry(self)!, rationale: "Auto-registered by hand." }));
  assert.equal(rewriteDispositionRecords(root, false).status, "regenerated");
  const healed = rewriteDispositionRecords(root, true);
  assert.deepEqual(healed.changed, [dispositionRecordPath(self)]);
  assert.deepEqual(dispositionRecordFiles(root), dispositionRecordFiles(REPOSITORY_ROOT), "healed to the live records, the one writer's output");
});

test("a record decided under a stale POLICY refuses by name, and nothing is rewritten", () => {
  const root = scratchRecords();
  const [first] = dispositionRecordFiles(root);
  assert.ok(first !== undefined);
  // The state a renamed test directory produces: the decision untouched, the policy it was made under gone. A hash
  // well-formed and not the current one, so the refusal cannot be about a malformed field.
  const stale = first.text.replace(testSurfacePolicyHash(), "1".repeat(64));
  assert.notEqual(stale, first.text);
  writeRecord(root, first.path, stale);
  const source = decodeURIComponent(first.path.slice(RECORDS.length + 1, -".json".length));
  for (const attempt of [() => rewriteDispositionRecords(root, true), () => readDispositionManifest(root)]) {
    assert.throws(attempt, (error: unknown) => {
      assert.ok(error instanceof HarnessError, `expected HarnessError, got ${String(error)}`);
      assert.equal(error.code, "test_surface_disposition_policy_stale");
      assert.match(error.message, new RegExp(`test-surface disposition of ${source.replaceAll(".", "\\.")} was decided under another discovery policy`, "u"));
      return true;
    });
  }
  // THE POINT: the stale record is still on disk as it was; no writer re-blessed it.
  assert.equal(readFileSync(join(root, first.path), "utf8"), stale);
});

test("THE CONSERVATION PINS ARE NOT THE POLICY: restating them keeps every record current; any other discovery change stales each one, and nothing re-signs it (design M4)", () => {
  const discovery = ROOT_POLICY.verification.testDiscovery;
  const { surfaceConservation: _pins, ...policy } = discovery;
  assert.equal(testSurfacePolicyHash(), canonicalHash(policy), "the pinned policy is the discovery policy without its conservation pins");
  assert.notEqual(testSurfacePolicyHash(), canonicalHash(discovery), "the pins are not part of it");
  for (const record of dispositionRecordFiles(REPOSITORY_ROOT)) {
    assert.equal((JSON.parse(record.text) as { policyHash: string }).policyHash, testSurfacePolicyHash(), `${record.path} is decided under the pin-free policy`);
  }
  assert.equal(rewriteDispositionRecords.length, 2, "the rewrite takes the engine root and the write flag, nothing else: no token re-blesses a stale policy");
});

test("a hand-edited record is rejected by the SCHEMA", () => {
  const [first] = dispositionRecordFiles(REPOSITORY_ROOT);
  assert.ok(first !== undefined);
  const record = JSON.parse(first.text) as Record<string, unknown>;
  assert.throws(() => parseDispositionRecord(first.path, JSON.stringify({ ...record, unexpectedField: "smuggled" })), /unrecognized_keys|Unrecognized key/u);
  assert.throws(() => parseDispositionRecord(first.path, JSON.stringify({ ...record, disposition: "definitely-fine" })));
  assert.throws(() => parseDispositionRecord(first.path, JSON.stringify({ ...record, path: "elsewhere.test.ts" })), "the location is the path: a record may not name another");
  assert.throws(() => parseDispositionRecord("traceability/elsewhere/x.test.ts.json", first.text), /not a disposition record/u);
  assert.throws(() => parseDispositionRecord(`${RECORDS}/live/x.test.ts.json`, first.text), /not a disposition record/u, "the directory is flat");
  // BENIGN CONTROL: the record as it is parses, and its location is its source's one spelling.
  const parsed = parseDispositionRecord(first.path, first.text);
  assert.equal(dispositionRecordPath(parsed.path), first.path);
});

test("two branches that each decide a source merge with no conflict: each decision is its own file (git merge-tree)", () => {
  const repository = createTempDir("disposition-records-merge-");
  const git = (...args: readonly string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: repository, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  cpSync(join(REPOSITORY_ROOT, RECORDS), join(repository, RECORDS), { recursive: true });
  git("add", "--", RECORDS);
  git("commit", "-q", "-m", "base");
  const decide = (branch: string, source: string): void => {
    git("checkout", "-q", "-b", branch, "main");
    const entry = { path: source, language: "javascript-typescript" as const, disposition: "qualified-external-oracle" as const, rationale: `decided on ${branch}`, evidenceLinks: ["package.json"], blocksFullRepositoryClaim: false };
    writeRecord(repository, dispositionRecordPath(source), serializeDispositionRecord(entry));
    git("add", "--", RECORDS);
    git("commit", "-q", "-m", branch);
  };
  // Neighbours in sort order: the shape that conflicted in the one-file manifest.
  decide("one", "live/aaa-oracle.test.ts");
  decide("two", "live/aab-oracle.test.ts");
  const merged = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "one", "two"], { cwd: repository, encoding: "utf8" });
  assert.equal(merged.status, 0, `the two decisions conflicted:\n${merged.stdout}`);
  const tree = merged.stdout.split("\n")[0]!;
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", tree], { cwd: repository, encoding: "utf8" }).split("\n");
  for (const source of ["live/aaa-oracle.test.ts", "live/aab-oracle.test.ts"]) assert.ok(files.includes(dispositionRecordPath(source)), `${source}'s record survived the merge`);
});

test("there is exactly one module that writes a disposition manifest", () => {
  // The structural half. The owner is the only thing that assembles the
  // manifest (its role) and stamps a record's policy, so the
  // search is for a SECOND place that assembles it — the shape the inlined
  // copy had. Derived from the source, tree-wide, read as bytes.
  // The owner's src/-relative path, resolved from the tree — the fold moved it
  // under kernel/, so it is never spelled here.
  const owner = engineModuleSourceRelative("test-surface-manifest.ts");
  const signedRole = "recognizable-test-surface-disposition-exceptions";
  const searched: string[] = [];
  const offenders: string[] = [];

  for (const full of ["src", "scripts"].flatMap((root) => walk(join(REPOSITORY_ROOT, root), { exts: [".ts"] }))) {
    const relativePath = relative(REPOSITORY_ROOT, full).split(sep).join("/");
    if (relativePath === owner) continue;
    searched.push(relativePath);
    // The role literal is what a writer must state to assemble a signed
    // manifest. A reader never needs it.
    if (readFileSync(full, "utf8").includes(`"${signedRole}"`)) offenders.push(relativePath);
  }

  assert.ok(searched.length > 100, `the walk found ${searched.length} files`);
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} module(s) besides ${owner} assemble a signed disposition manifest: ` +
      `${offenders.join(", ")}. Extend the owner; a second writer of a pin is a pin that can be ` +
      `re-blessed.`,
  );

  // LIVENESS on the detector itself: it must find the owner when the owner is
  // not excluded, otherwise the empty answer above is about a scan that reads
  // nothing.
  const ownerSource = readFileSync(join(REPOSITORY_ROOT, owner), "utf8");
  assert.ok(ownerSource.includes(`"${signedRole}"`));
});
