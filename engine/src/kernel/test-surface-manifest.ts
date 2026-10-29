import { z } from "zod";

import { canonicalHash, deepFreeze } from "./integrity.ts";
import { HarnessError } from "./errors.ts";
import { assertNoDuplicateJsonObjectKeys } from "./json-integrity.ts";
import { compareUtf8Bytes } from "./ordered.ts";
import { relativePathViolationKinds } from "../filesystem/path-boundary.ts";
import { ROOT_POLICY } from "./root-policy.ts";
import { shouldExcludeExperiment } from "../shared/source-scan.ts";

/**
 * THE TEST-SURFACE DISPOSITION MANIFEST — ONE OWNER, ONE WRITER.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * This manifest is a PIN. It records which recognizable test source is
 * canonical, which is a fixture, which is unsupported — and each record's
 * `policyHash` ties that decision to the discovery policy it was made under.
 * When a directory is renamed, a stale `policyHash` is one of the eight
 * refusals that stop a suite from silently running a smaller set of tests
 * than it claims.
 *
 * ── ONE RECORD PER DECISION ───────────────────────────────────────────────
 *
 * On disk the manifest is a directory (`dispositionRegistry.recordsPath`), one
 * record per decided source, its path percent-encoded into the record's file
 * name (`dispositionRecordPath`): the source's path is the record's location, its language is derived from the path, and
 * the record holds the decision and the policy hash it was made under. Two
 * branches that each decide a source never touch the same file, and no
 * whole-manifest hash moves (a single shared `policyHash` line used to
 * conflict on every merge that touched the discovery policy). The policy's
 * identity is computed from the root policy whenever a record is read
 * ({@link testSurfacePolicyHash}), never committed beside the records.
 *
 * There were TWO writers. The builder-layer verification module had the
 * schema-validated one; `harness regenerate` carried an inlined copy that
 * parsed the manifest with a raw `JSON.parse`, checked two fields by hand,
 * and rewrote `policyHash` UNCONDITIONALLY from the current policy. That
 * second writer was the reason a stale-policy refusal could be walked past:
 * a pin a generator can silently re-bless refuses nothing.
 *
 * Its own comment said why it was a copy — importing the builder module would
 * put `src/ → scripts/` into the runtime import graph, which the architecture
 * forbids. The reason was true and the conclusion was not: the shared half
 * depends on NOTHING in the builder layer. Every input it needs — the schema
 * library, canonical hashing, the error type, duplicate-key detection, byte
 * ordering, path-boundary validation and the root policy — already lives in
 * the runtime layer. So the half both callers need moved DOWN to where both
 * may import it, rather than being copied sideways.
 *
 * ── WHAT IS HERE, AND WHAT DELIBERATELY IS NOT ────────────────────────────
 *
 * Here: what a disposition entry IS, what a manifest IS, how a path is
 * recognized and qualified, the default every qualified Node test source
 * takes without an entry, and the only two doors — `create…` (which writes
 * the one form) and `parse…` (which verifies). Both go through the same schema, so there is
 * no shape a writer can produce that a reader would not accept, and no field
 * a writer can set that the schema does not declare.
 *
 * Not here: the CONSERVATION identity, the pinned-set refusals and the scope
 * projection. Those are checks a builder performs about the repository, not
 * facts about the manifest, and they stay in the verification module beside
 * the rest of the build-time verification.
 *
 * ── THE PROPERTY THAT MATTERS ─────────────────────────────────────────────
 *
 * A record's `policyHash` is written by `serializeDispositionRecord` and
 * verified by `parseDispositionRecord`, and there is no third path. A caller
 * that rewrites the records round-trips through both — so a decision whose
 * policy has genuinely moved on REFUSES instead of being quietly re-blessed,
 * which is the whole point of pinning it.
 *
 * ── ONLY THE EXCEPTIONS ARE WRITTEN (#221) ────────────────────────────────
 *
 * A recognizable Node test source under a qualified pattern is
 * `canonical-node-test` BY DEFAULT: it has no entry. Every other disposition
 * (an external oracle, a pending or unsupported source, a fixture) and a
 * canonical source that carries evidence is an entry. The manifest used to
 * hold one entry per test file plus a whole-file `integrityHash`, so every
 * branch that added a test rewrote it and two unrelated PRs collided in the
 * merge queue; adding a canonical test now changes nothing here. The
 * conservation identity (`assertTestSurfaceConservation`, pinned counts and
 * hashes of the non-canonical and excluded sets) still refuses a rename that
 * moves sources out of the qualified patterns.
 */
const DISCOVERY = ROOT_POLICY.verification.testDiscovery;

/**
 * THE POLICY A MANIFEST IS PINNED TO: the discovery policy WITHOUT its
 * conservation pins. The pins (`surfaceConservation`: the excluded and the
 * non-canonical sets' counts and hashes) are restated by hand when the
 * surface moves, and each is checked on every inventory run against the git
 * index by the conservation identity (scripts/verification/test-surface.ts
 * `assertTestSurfaceConservation`) — the independent check. Hashing them here
 * made every legitimate restatement stale the manifest, which needed a manual
 * re-sign door (design M4). A change to anything else — a root, a pattern, a
 * rule — still stales it, and still refuses.
 */
export function testSurfacePolicyHash(): string {
  const { surfaceConservation: _pins, ...policy } = DISCOVERY;
  return canonicalHash(policy);
}
const DISPOSITIONS = DISCOVERY.dispositionRegistry.allowedDispositions;
const RECOGNIZABLE_PATTERNS = Object.freeze({
  "javascript-typescript": new RegExp(DISCOVERY.recognizableSourcePatterns.javaScriptTypeScript, "u"),
  python: new RegExp(DISCOVERY.recognizableSourcePatterns.python, "u"),
});
/**
 * One compiled matcher per declared qualified pattern, in declaration order.
 *
 * Exported because the builder layer's per-pattern liveness refusal judges
 * these same matchers: two compilations of one declaration would be two
 * answers to one question.
 */
export const QUALIFIED_TEST_SOURCE_MATCHERS = DISCOVERY.qualifiedSourcePatterns.map(compileRestrictedTestGlob);
/** A non-empty string, shared with the scope schema in the builder layer. */
export const NONEMPTY_STRING = z.string().min(1);
const ENTRY_SCHEMA = z.strictObject({
  path: NONEMPTY_STRING.refine((path) => relativePathViolationKinds(path).length === 0),
  language: z.enum(["javascript-typescript", "python"]),
  disposition: z.enum(DISPOSITIONS),
  rationale: NONEMPTY_STRING,
  evidenceLinks: z.array(NONEMPTY_STRING),
  blocksFullRepositoryClaim: z.boolean(),
});
const MANIFEST_SCHEMA = z.strictObject({
  role: z.literal("recognizable-test-surface-disposition-exceptions"),
  entries: z.array(ENTRY_SCHEMA),
});
/** One record on disk: the decision about the source its location names, and the policy it was decided under. */
const RECORD_SCHEMA = z.strictObject({
  schemaVersion: z.literal(DISCOVERY.dispositionRegistry.schemaVersion),
  policyHash: z.string().regex(/^[0-9a-f]{64}$/u),
  disposition: z.enum(DISPOSITIONS),
  rationale: NONEMPTY_STRING,
  evidenceLinks: z.array(NONEMPTY_STRING),
  blocksFullRepositoryClaim: z.boolean(),
});
/** The records' directory, engine-relative. */
export const DISPOSITION_RECORDS_PATH: string = DISCOVERY.dispositionRegistry.recordsPath;
const RECORD_SUFFIX = ".json";

export type TestSurfaceDispositionEntry = Readonly<z.infer<typeof ENTRY_SCHEMA>>;
export type TestSurfaceDispositionManifest = Readonly<z.infer<typeof MANIFEST_SCHEMA>>;

export function isQualifiedCanonicalNodeTestSource(path: string): boolean {
  return QUALIFIED_TEST_SOURCE_MATCHERS.some((matcher) => matcher.test(path));
}

/** The rationale of a qualified Node test source that has no entry. */
const DEFAULT_CANONICAL_RATIONALE = "Qualified by the central Node test pattern: canonical by default, with no entry.";

/** The disposition a recognizable `path` takes WITHOUT an entry: canonical for a qualified Node test source, none otherwise. */
export function defaultDispositionEntry(path: string): TestSurfaceDispositionEntry | undefined {
  if (recognizableTestSourceLanguage(path) !== "javascript-typescript" || !isQualifiedCanonicalNodeTestSource(path)) return undefined;
  return deepFreeze({ path, language: "javascript-typescript", disposition: "canonical-node-test", rationale: DEFAULT_CANONICAL_RATIONALE, evidenceLinks: [], blocksFullRepositoryClaim: false });
}

/** Is `entry` exactly what its path takes by default (a canonical qualified source with no evidence)? Such an entry is never written. */
function isDefaultDisposition(entry: TestSurfaceDispositionEntry): boolean {
  return entry.disposition === "canonical-node-test" && entry.evidenceLinks.length === 0 && defaultDispositionEntry(entry.path) !== undefined;
}

/** How many paths a coverage refusal names before it only counts them. */
const NAMED_IN_A_REFUSAL = 10;

/**
 * EVERY RECOGNIZABLE SOURCE'S DISPOSITION: its entry, or the default it takes
 * without one. Refuses (`test_surface_disposition_coverage_incomplete`) when a
 * source has neither (it lies outside the qualified patterns and nobody
 * decided what it is) or an entry names a source that is not on the surface.
 */
export function effectiveDispositionEntries(
  recognizablePaths: readonly string[],
  manifest: TestSurfaceDispositionManifest,
): readonly TestSurfaceDispositionEntry[] {
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry] as const));
  const surface = new Set(recognizablePaths);
  const undecided = recognizablePaths.filter((path) => !byPath.has(path) && defaultDispositionEntry(path) === undefined);
  const stale = manifest.entries.map((entry) => entry.path).filter((path) => !surface.has(path));
  if (undecided.length > 0 || stale.length > 0) {
    throw new HarnessError(
      "test-surface disposition coverage is incomplete" +
        (undecided.length === 0 ? "" : `: ${String(undecided.length)} recognizable source(s) outside the qualified patterns have no entry (${undecided.slice(0, NAMED_IN_A_REFUSAL).join(", ")})`) +
        (stale.length === 0 ? "" : `; ${String(stale.length)} entr${stale.length === 1 ? "y names a source" : "ies name sources"} not on the surface (${stale.slice(0, NAMED_IN_A_REFUSAL).join(", ")})`),
      "test_surface_disposition_coverage_incomplete",
      false,
      { undecided: String(undecided.length), stale: String(stale.length) },
    );
  }
  return deepFreeze(recognizablePaths.map((path) => byPath.get(path) ?? defaultDispositionEntry(path)!).toSorted((left, right) => compareUtf8Bytes(left.path, right.path)));
}

// Foundation-cascade tests create temporary UUID-based .test.ts files in
// test/support/. These are test fixtures, not real test sources — they
// should not be registered in the inventory. This pattern matches them.
const FOUNDATION_CASCADE_RESIDUE_PATTERN =
  /test\/support\/(?:foundation-cascade|\.foundation-cascade)-[a-z-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

export function recognizableTestSourceLanguage(
  path: string,
): "javascript-typescript" | "python" | undefined {
  if (relativePathViolationKinds(path).length > 0) return undefined;
  // Exclude foundation-cascade residue files (UUID-based .test.ts files
  // created by the foundation-cascade tests in test/support/).
  if (FOUNDATION_CASCADE_RESIDUE_PATTERN.test(path)) return undefined;
  for (const [language, pattern] of Object.entries(RECOGNIZABLE_PATTERNS)) {
    if (pattern.test(path)) return language as "javascript-typescript" | "python";
  }
  return undefined;
}

/**
 * IS THIS PATH A RECOGNIZABLE TEST SOURCE THAT THE SUITE CAN ACTUALLY RUN?
 *
 * The single owner of the per-path half of "in scope for the test surface".
 * `recognizableTestSourceLanguage` answers only "does this look like a test
 * source"; this adds every exclusion the repository walk applies, so the two
 * instruments that answer the same question — the walk over the disk and the
 * git index — can be filtered identically instead of by two hand-kept copies.
 *
 * The walk prunes excluded DIRECTORIES during traversal, which is a
 * performance decision; the decision itself is here, and
 * `readRecognizableTestSurface` applies this function as its final filter so
 * the walk cannot answer differently from the index. A test asserts the two
 * agree on the live tree, because "one owner" is a claim that has to be
 * measured.
 */
export function isScannedRecognizableTestSource(path: string): boolean {
  if (recognizableTestSourceLanguage(path) === undefined) return false;
  const configuration = ROOT_POLICY.configuration;
  const segments = path.split("/");
  const fileName = segments.at(-1) ?? "";
  if (segments.slice(0, -1).some((segment) =>
    (configuration.repositoryScanExclusions as readonly string[]).includes(segment))) {
    return false;
  }
  if ((configuration.repositoryScanFileExclusions as readonly string[]).includes(fileName)) return false;
  if (configuration.repositoryScanFileSuffixExclusions.some((suffix) => path.endsWith(suffix))) return false;
  return !shouldExcludeExperiment(path);
}

/** The manifest in its one form: the exceptions only (an entry a path takes by default is dropped), sorted by path. */
export function createTestSurfaceDispositionManifest(
  entries: readonly TestSurfaceDispositionEntry[],
): TestSurfaceDispositionManifest {
  return parseTestSurfaceDispositionManifest({
    role: "recognizable-test-surface-disposition-exceptions",
    entries: entries.filter((entry) => !isDefaultDisposition(entry)).toSorted((left, right) => compareUtf8Bytes(left.path, right.path)),
  });
}

/**
 * The engine-relative location of `source`'s record: ONE flat directory, the
 * source's path percent-encoded into the file name (`live%2Fx.test.ts.json`),
 * reversibly and without collision, so the directory holds files and its README only.
 */
export function dispositionRecordPath(source: string): string {
  return `${DISPOSITION_RECORDS_PATH}/${encodeURIComponent(source)}${RECORD_SUFFIX}`;
}

/** The record's bytes for `entry`, decided under the CURRENT policy (the only writer stamps the hash it writes under). */
export function serializeDispositionRecord(entry: TestSurfaceDispositionEntry): string {
  const record = RECORD_SCHEMA.parse({
    schemaVersion: DISCOVERY.dispositionRegistry.schemaVersion,
    policyHash: testSurfacePolicyHash(),
    disposition: entry.disposition,
    rationale: entry.rationale,
    evidenceLinks: entry.evidenceLinks,
    blocksFullRepositoryClaim: entry.blocksFullRepositoryClaim,
  });
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * ONE RECORD READ: the entry for the source its location names, its language
 * derived from the path. A record decided under another discovery policy is
 * REFUSED by name (`test_surface_disposition_policy_stale`): the decision was
 * made under rules that no longer apply, and no writer re-blesses it.
 */
export function parseDispositionRecord(recordPath: string, text: string): TestSurfaceDispositionEntry {
  const name = recordPath.slice(DISPOSITION_RECORDS_PATH.length + 1);
  if (!recordPath.startsWith(`${DISPOSITION_RECORDS_PATH}/`) || name.includes("/") || !name.endsWith(RECORD_SUFFIX)) {
    throw new HarnessError(`not a disposition record: ${recordPath}`, "test_surface_disposition_record_misplaced", false, { recordPath });
  }
  assertNoDuplicateJsonObjectKeys(text, `Test-surface disposition record contains a duplicate key: ${recordPath}`, "test_surface_disposition_key_duplicate");
  const record = RECORD_SCHEMA.parse(JSON.parse(text) as unknown);
  const path = decodeURIComponent(name.slice(0, -RECORD_SUFFIX.length));
  if (dispositionRecordPath(path) !== recordPath) {
    throw new HarnessError(`not a disposition record's one spelling: ${recordPath}`, "test_surface_disposition_record_misplaced", false, { recordPath });
  }
  if (record.policyHash !== testSurfacePolicyHash()) {
    throw new HarnessError(
      `test-surface disposition of ${path} was decided under another discovery policy (its policyHash is stale): re-decide it under the current policy`,
      "test_surface_disposition_policy_stale",
      false,
      { path, recordPolicyHash: record.policyHash, currentPolicyHash: testSurfacePolicyHash() },
    );
  }
  const language = recognizableTestSourceLanguage(path);
  if (language === undefined) {
    throw new HarnessError(`test-surface disposition names no recognizable test source: ${path}`, "test_surface_disposition_language_invalid", false, { path, declared: "derived", recognized: "none" });
  }
  const { schemaVersion: _version, policyHash: _policy, ...decision } = record;
  return deepFreeze({ path, language, ...decision });
}

/** The manifest the records at `records` (engine-relative paths and their bytes) hold. */
export function dispositionManifestFromRecords(records: readonly Readonly<{ path: string; text: string }>[]): TestSurfaceDispositionManifest {
  const entries = records.map((record) => parseDispositionRecord(record.path, record.text));
  return parseTestSurfaceDispositionManifest({
    role: "recognizable-test-surface-disposition-exceptions",
    entries: entries.toSorted((left, right) => compareUtf8Bytes(left.path, right.path)),
  });
}

/** The records `manifest` is written as: one per entry, at its location, in the one form. */
export function dispositionRecordsOf(manifest: TestSurfaceDispositionManifest): readonly Readonly<{ path: string; text: string }>[] {
  return deepFreeze(manifest.entries.map((entry) => ({ path: dispositionRecordPath(entry.path), text: serializeDispositionRecord(entry) })));
}

export function parseTestSurfaceDispositionManifest(value: unknown): TestSurfaceDispositionManifest {
  const parsed = MANIFEST_SCHEMA.parse(value);
  const sorted = [...parsed.entries].toSorted((left, right) => compareUtf8Bytes(left.path, right.path));
  if (new Set(parsed.entries.map((entry) => entry.path)).size !== parsed.entries.length ||
    canonicalHash(sorted) !== canonicalHash(parsed.entries)) {
    throw new HarnessError(
      "test-surface disposition entries are duplicated or unordered",
      "test_surface_disposition_entries_unordered",
      false,
      { entryCount: String(parsed.entries.length) },
    );
  }
  for (const entry of parsed.entries) assertDispositionSemantics(entry);
  return deepFreeze(parsed) as TestSurfaceDispositionManifest;
}

function assertDispositionSemantics(entry: TestSurfaceDispositionEntry): void {
  const language = recognizableTestSourceLanguage(entry.path);
  if (language === undefined || language !== entry.language) {
    throw new HarnessError(
      `test-surface disposition language is invalid: ${entry.path}`,
      "test_surface_disposition_language_invalid",
      false,
      { path: entry.path, declared: entry.language, recognized: language ?? "none" },
    );
  }
  const qualified = isQualifiedCanonicalNodeTestSource(entry.path);
  if (entry.disposition === "canonical-node-test" && (!qualified ||
    entry.language === "python")) {
    throw new HarnessError(
      `test-surface canonical disposition is invalid: ${entry.path}`,
      "test_surface_disposition_canonical_invalid",
      false,
      { path: entry.path, language: entry.language },
    );
  }
  const blocks = entry.disposition === "pending-external-qualification" ||
    entry.disposition === "unsupported-blocking";
  if (entry.blocksFullRepositoryClaim !== blocks) {
    throw new HarnessError(
      `test-surface claim blocking is invalid: ${entry.path}`,
      "test_surface_disposition_claim_blocking_invalid",
      false,
      { path: entry.path, disposition: entry.disposition },
    );
  }
  if ((entry.disposition === "qualified-external-oracle" || entry.disposition === "non-test-fixture") &&
    entry.evidenceLinks.length === 0) {
    throw new HarnessError(
      `test-surface disposition evidence is missing: ${entry.path}`,
      "test_surface_disposition_evidence_missing",
      false,
      { path: entry.path, disposition: entry.disposition },
    );
  }
}

function compileRestrictedTestGlob(pattern: string): RegExp {
  if (pattern.startsWith("/") || pattern.includes("\\") ||
    relativePathViolationKinds(pattern.replaceAll("*", "x")).length > 0 || /[?\[\]{}]/u.test(pattern)) {
    throw new HarnessError(
      `unsupported qualified test-source pattern: ${pattern}`,
      "qualified_test_pattern_unsupported",
      false,
      { pattern },
    );
  }
  const segments = pattern.split("/");
  let source = "^";
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment === "**") {
      source += "(?:[^/]+/)*";
      continue;
    }
    source += segment.split("*").map(escapeRegExp).join("[^/]*");
    if (index < segments.length - 1) source += "/";
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+^${}()|[\]\\]/gu, "\\$&");
}
