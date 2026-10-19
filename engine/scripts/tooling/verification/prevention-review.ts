export const PREVENTION_REVIEW_SCHEMA_VERSION = "bridlewise-prevention-review/v2" as const;
const HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE_SCHEMA_VERSION =
  "bridlewise-handoff-continuity-occurrence-bundle/v1" as const;

const HANDOFF_CONTINUITY_SOURCE_ID = "source:current-subagent-steering-task-continuity-recurrence";
const HANDOFF_CONTINUITY_INCIDENT_ID = "INC-ARCH-013";
const HANDOFF_PROPOSAL_DISPOSITION = "rejected-wrong-subject";
const HANDOFF_PARENT_DECISION = "reject-and-resume";
const HANDOFF_RUNTIME_ATTEMPT_ID = "unavailable-not-generated";
const HANDOFF_CORRECTED_RESULT_STATES = new Set([
  "pending-corrected-result",
  "received-after-resume",
  "superseded-by-another-rejected-proposal",
]);

export const PREVENTION_CLASSES = [
  "centrally-prevented-narrowly",
  "prevention-missing",
  "capability-unavailable",
  "exact-history-unrecoverable",
] as const;

export type PreventionClass = typeof PREVENTION_CLASSES[number];

export type FormalFindingFact = Readonly<{
  id: string;
  path: string;
  status: string;
}>;

export type ArchitectureFindingFact = Readonly<{
  id: string;
  status: string;
}>;

export type PreventionSourceFact = Readonly<{
  id: string;
  kind: string;
  locator: string;
  availability: string;
  observedStatus: string;
  incidentIds: readonly string[];
  claimLimit: string;
  handoffContinuityOccurrenceBundle?: HandoffContinuityOccurrenceBundle;
}>;

type HandoffContinuityOccurrence = Readonly<{
  taskPath: string;
  withinTaskAttemptOrdinal: number;
  proposalDisposition: typeof HANDOFF_PROPOSAL_DISPOSITION;
  parentDecision: typeof HANDOFF_PARENT_DECISION;
  correctedResultState: "pending-corrected-result" | "received-after-resume" |
    "superseded-by-another-rejected-proposal";
  runtimeAttemptId: typeof HANDOFF_RUNTIME_ATTEMPT_ID;
  incidentId: typeof HANDOFF_CONTINUITY_INCIDENT_ID;
}>;

type HandoffContinuityOccurrenceBundle = Readonly<{
  schemaVersion: typeof HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE_SCHEMA_VERSION;
  handoffContinuityOccurrences: readonly HandoffContinuityOccurrence[];
}>;

export type PreventionIncidentExpectation = Readonly<{
  id: string;
  classifications: readonly PreventionClass[];
}>;

export type PreventionReviewFacts = Readonly<{
  formalFindings: readonly FormalFindingFact[];
  architectureFindings: readonly ArchitectureFindingFact[];
  additionalSources: readonly PreventionSourceFact[];
  incidentExpectations: readonly PreventionIncidentExpectation[];
}>;

export type PreventionReviewResult = Readonly<{
  valid: boolean;
  violations: readonly string[];
}>;

type UnknownRecord = Record<string, unknown>;

const CLASS_SET = new Set<string>(PREVENTION_CLASSES);
const AVAILABILITY = new Set([
  "available-governed-current",
  "available-governed-superseded",
  "available-unadmitted-agent-report",
  "available-unadmitted-observation",
  "unavailable-exact-bytes",
  "prohibited-confidentiality-tainted",
  "mixed-changing-epoch",
]);
const REVIEW_STATES = new Set(["recorded-unreviewed", "independently-reviewed", "closed"]);
const PREVENTION_STATES = new Set([
  "implemented-narrow-boundary",
  "specified-not-implemented",
  "capability-unavailable",
  "exact-history-unrecoverable",
]);
const BOUNDARIES = new Set(["pre-effect", "pre-claim", "both"]);
const MODEL_ROLE = "non-authoritative-defense-in-depth-only";

export function parseFormalFindingFact(path: string, markdown: string): FormalFindingFact {
  const title = /^#\s+([A-Z]+-\d+)\b/mu.exec(markdown);
  const statusLine = /^\s*(?:-\s*)?Status:\s*(.+?)\s*$/imu.exec(markdown);
  if (title === null || statusLine === null) {
    throw new Error(`prevention-review-formal-finding-unparseable:${path}`);
  }
  const rawStatus = statusLine[1]!
    .replaceAll("`", "")
    .replaceAll("*", "")
    .trim()
    .toLowerCase()
    .replace(/[ _]+/gu, "-");
  return { id: title[1]!, path, status: rawStatus };
}

export function discoverExpectedPreventionSources(facts: PreventionReviewFacts): readonly PreventionSourceFact[] {
  const discovered: PreventionSourceFact[] = [];
  for (const finding of facts.formalFindings) {
    discovered.push({
      id: `formal-finding:${finding.path}`,
      kind: "formal-finding-file",
      locator: finding.path,
      availability: "available-governed-current",
      observedStatus: finding.status,
      incidentIds: [`INC-FORMAL-${finding.id}`],
      claimLimit: "The current file is authoritative only for its stated finding and explicit closure limits.",
    });
  }
  for (const finding of facts.architectureFindings) {
    const family = /^[A-Z]+-\d+/u.exec(finding.id)?.[0];
    if (family === undefined) throw new Error(`prevention-review-architecture-id-invalid:${finding.id}`);
    discovered.push({
      id: `architecture-finding:${finding.id}`,
      kind: "architecture-finding",
      locator: `src/architecture-manifest.ts#${finding.id}`,
      availability: "available-governed-current",
      observedStatus: finding.status,
      incidentIds: [`INC-FORMAL-${family}`],
      claimLimit: "The live architecture entry is a changing-worktree observation, not frozen historical evidence.",
    });
  }
  discovered.push(...facts.additionalSources);
  return discovered.toSorted((left, right) => left.id.localeCompare(right.id));
}

export function verifyPreventionReview(document: unknown, facts: PreventionReviewFacts): PreventionReviewResult {
  const violations: string[] = [];
  const root = record(document, "document", violations);
  if (root === undefined) return result(violations);
  exactKeys(root, ["schemaVersion", "reviewId", "epoch", "sourceManifest", "rows"], "document", violations);
  if (root.schemaVersion !== PREVENTION_REVIEW_SCHEMA_VERSION) violations.push("review-schema-version-invalid");
  nonEmptyString(root.reviewId, "review-id", violations);
  verifyEpoch(root.epoch, violations);

  const sourceEntries = array(root.sourceManifest, "source-manifest", violations);
  const rows = array(root.rows, "rows", violations);
  if (sourceEntries === undefined || rows === undefined) return result(violations);

  const expectedSources = discoverExpectedPreventionSources(facts);
  const expectedSourceById = uniqueMap(expectedSources, (entry) => entry.id, "fact-source-duplicate", violations);
  const actualSourceById = new Map<string, PreventionSourceFact>();
  for (const [index, value] of sourceEntries.entries()) {
    const parsed = verifySource(value, index, violations);
    if (parsed === undefined) continue;
    if (actualSourceById.has(parsed.id)) violations.push(`source-duplicate:${parsed.id}`);
    else actualSourceById.set(parsed.id, parsed);
  }
  for (const [id, expected] of expectedSourceById) {
    const actual = actualSourceById.get(id);
    if (actual === undefined) {
      violations.push(`source-omitted:${id}`);
      continue;
    }
    if (canonicalSource(actual) !== canonicalSource(expected)) violations.push(`source-fact-drift:${id}`);
  }
  for (const id of actualSourceById.keys()) {
    if (!expectedSourceById.has(id)) violations.push(`source-unsubstantiated:${id}`);
  }

  const expectationById = uniqueMap(
    facts.incidentExpectations,
    (entry) => entry.id,
    "fact-incident-duplicate",
    violations,
  );
  const expectedIncidentIds = new Set(expectationById.keys());
  for (const source of expectedSources) {
    for (const incidentId of source.incidentIds) expectedIncidentIds.add(incidentId);
  }
  const rowsById = new Map<string, UnknownRecord>();
  const referencedSources = new Set<string>();
  const sourceRefsByIncident = new Map<string, Set<string>>();
  for (const [index, value] of rows.entries()) {
    const parsed = record(value, `row-${index}`, violations);
    if (parsed === undefined) continue;
    verifyRow(parsed, index, expectedSourceById, expectationById, referencedSources, sourceRefsByIncident, violations);
    const id = typeof parsed.id === "string" ? parsed.id : `invalid-row-${index}`;
    if (rowsById.has(id)) violations.push(`row-duplicate:${id}`);
    else rowsById.set(id, parsed);
  }
  for (const id of expectedIncidentIds) {
    if (!rowsById.has(id)) violations.push(`incident-omitted:${id}`);
  }
  for (const id of rowsById.keys()) {
    if (!expectedIncidentIds.has(id)) violations.push(`incident-unsubstantiated:${id}`);
  }
  for (const source of expectedSources) {
    if (!referencedSources.has(source.id)) violations.push(`source-unreferenced:${source.id}`);
    for (const incidentId of source.incidentIds) {
      if (!sourceRefsByIncident.get(incidentId)?.has(source.id)) {
        violations.push(`source-incident-link-omitted:${source.id}:${incidentId}`);
      }
    }
  }
  return result(violations);
}

function verifyEpoch(value: unknown, violations: string[]): void {
  const epoch = record(value, "epoch", violations);
  if (epoch === undefined) return;
  exactKeys(epoch, ["kind", "capturedAt", "completenessClaim"], "epoch", violations);
  if (epoch.kind !== "mixed-changing-worktree") violations.push("epoch-kind-must-remain-mixed-changing-worktree");
  nonEmptyString(epoch.capturedAt, "epoch-captured-at", violations);
  if (epoch.completenessClaim !== "complete-for-manifested-available-sources-history-unassessed") {
    violations.push("epoch-historical-completeness-overclaimed");
  }
}

function verifySource(value: unknown, index: number, violations: string[]): PreventionSourceFact | undefined {
  const source = record(value, `source-${index}`, violations);
  if (source === undefined) return undefined;
  const sourceId = typeof source.id === "string" ? source.id : undefined;
  const isHandoffContinuitySource = sourceId === HANDOFF_CONTINUITY_SOURCE_ID;
  exactKeys(
    source,
    ["id", "kind", "locator", "availability", "observedStatus", "incidentIds", "claimLimit",
      ...(isHandoffContinuitySource ? ["handoffContinuityOccurrenceBundle"] : [])],
    `source-${index}`,
    violations,
  );
  const id = nonEmptyString(source.id, `source-${index}-id`, violations);
  const kind = nonEmptyString(source.kind, `source-${index}-kind`, violations);
  const locator = nonEmptyString(source.locator, `source-${index}-locator`, violations);
  const availability = nonEmptyString(source.availability, `source-${index}-availability`, violations);
  const observedStatus = nonEmptyString(source.observedStatus, `source-${index}-observed-status`, violations);
  const incidentIds = stringArray(source.incidentIds, `source-${index}-incident-ids`, violations);
  const claimLimit = nonEmptyString(source.claimLimit, `source-${index}-claim-limit`, violations);
  const handoffContinuityOccurrenceBundle = isHandoffContinuitySource
    ? verifyHandoffContinuityOccurrenceBundle(source.handoffContinuityOccurrenceBundle, incidentIds, violations)
    : undefined;
  if (availability !== undefined && !AVAILABILITY.has(availability)) {
    violations.push(`source-${index}-availability-invalid`);
  }
  if (availability === "unavailable-exact-bytes" || availability === "prohibited-confidentiality-tainted") {
    if (observedStatus !== "unavailable-not-reconstructed" &&
      observedStatus !== "prohibited-no-content-use") {
      violations.push(`unavailable-source-disposition-invalid:${id ?? index}`);
    }
    if (claimLimit !== undefined &&
      !/(?:must\s+)?never\s+(?:be\s+)?(?:reconstruct(?:ed)?|us(?:e|ed))|must not|no content/iu.test(claimLimit)) {
      violations.push(`unavailable-source-claim-limit-weak:${id ?? index}`);
    }
  }
  if ([id, kind, locator, availability, observedStatus, claimLimit].some((entry) => entry === undefined) ||
    incidentIds === undefined || (isHandoffContinuitySource && handoffContinuityOccurrenceBundle === undefined)) {
    return undefined;
  }
  return { id: id!, kind: kind!, locator: locator!, availability: availability!, observedStatus: observedStatus!,
    incidentIds, claimLimit: claimLimit!,
    ...(handoffContinuityOccurrenceBundle === undefined ? {} : { handoffContinuityOccurrenceBundle }) };
}

function verifyHandoffContinuityOccurrenceBundle(
  value: unknown,
  sourceIncidentIds: readonly string[] | undefined,
  violations: string[],
): HandoffContinuityOccurrenceBundle | undefined {
  const bundle = record(value, "handoff-continuity-occurrence-bundle", violations);
  if (bundle === undefined) return undefined;
  exactKeys(bundle, ["schemaVersion", "handoffContinuityOccurrences"],
    "handoff-continuity-occurrence-bundle", violations);
  if (bundle.schemaVersion !== HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE_SCHEMA_VERSION) {
    violations.push("handoff-continuity-occurrence-bundle-schema-version-invalid");
  }
  const candidates = array(bundle.handoffContinuityOccurrences,
    "handoff-continuity-occurrences", violations);
  if (candidates === undefined) return undefined;

  const occurrences: HandoffContinuityOccurrence[] = [];
  const locatorKeys = new Set<string>();
  const ordinalsByTask = new Map<string, number[]>();
  for (const [index, candidate] of candidates.entries()) {
    const label = `handoff-continuity-occurrence-${index}`;
    const occurrence = record(candidate, label, violations);
    if (occurrence === undefined) continue;
    exactKeys(occurrence, [
      "taskPath", "withinTaskAttemptOrdinal", "proposalDisposition", "parentDecision",
      "correctedResultState", "runtimeAttemptId", "incidentId",
    ], label, violations);
    const taskPath = nonEmptyString(occurrence.taskPath, `${label}-task-path`, violations);
    const ordinal = occurrence.withinTaskAttemptOrdinal;
    if (!Number.isInteger(ordinal) || Number(ordinal) < 1) {
      violations.push(`${label}-within-task-attempt-ordinal-invalid`);
    }
    if (occurrence.proposalDisposition !== HANDOFF_PROPOSAL_DISPOSITION) {
      violations.push(`${label}-proposal-disposition-invalid`);
    }
    if (occurrence.parentDecision !== HANDOFF_PARENT_DECISION) {
      violations.push(`${label}-parent-decision-invalid`);
    }
    if (typeof occurrence.correctedResultState !== "string" ||
      !HANDOFF_CORRECTED_RESULT_STATES.has(occurrence.correctedResultState)) {
      violations.push(`${label}-corrected-result-state-invalid`);
    }
    if (occurrence.runtimeAttemptId !== HANDOFF_RUNTIME_ATTEMPT_ID) {
      violations.push(`${label}-runtime-attempt-id-must-remain-unavailable`);
    }
    if (occurrence.incidentId !== HANDOFF_CONTINUITY_INCIDENT_ID ||
      sourceIncidentIds?.includes(HANDOFF_CONTINUITY_INCIDENT_ID) !== true) {
      violations.push(`${label}-incident-binding-invalid`);
    }
    if (taskPath === undefined || !Number.isInteger(ordinal) || Number(ordinal) < 1 ||
      occurrence.proposalDisposition !== HANDOFF_PROPOSAL_DISPOSITION ||
      occurrence.parentDecision !== HANDOFF_PARENT_DECISION ||
      typeof occurrence.correctedResultState !== "string" ||
      !HANDOFF_CORRECTED_RESULT_STATES.has(occurrence.correctedResultState) ||
      occurrence.runtimeAttemptId !== HANDOFF_RUNTIME_ATTEMPT_ID ||
      occurrence.incidentId !== HANDOFF_CONTINUITY_INCIDENT_ID) continue;

    const locatorKey = `${taskPath}:${String(ordinal)}`;
    if (locatorKeys.has(locatorKey)) violations.push(`handoff-continuity-occurrence-locator-duplicate:${locatorKey}`);
    locatorKeys.add(locatorKey);
    const ordinals = ordinalsByTask.get(taskPath) ?? [];
    ordinals.push(Number(ordinal));
    ordinalsByTask.set(taskPath, ordinals);
    occurrences.push({
      taskPath,
      withinTaskAttemptOrdinal: Number(ordinal),
      proposalDisposition: HANDOFF_PROPOSAL_DISPOSITION,
      parentDecision: HANDOFF_PARENT_DECISION,
      correctedResultState: occurrence.correctedResultState as HandoffContinuityOccurrence["correctedResultState"],
      runtimeAttemptId: HANDOFF_RUNTIME_ATTEMPT_ID,
      incidentId: HANDOFF_CONTINUITY_INCIDENT_ID,
    });
  }
  for (const [taskPath, ordinals] of ordinalsByTask) {
    const sorted = ordinals.toSorted((left, right) => left - right);
    if (sorted.some((ordinal, index) => ordinal !== index + 1)) {
      violations.push(`handoff-continuity-occurrence-ordinal-gap:${taskPath}`);
    }
  }
  if (occurrences.length !== candidates.length) return undefined;
  return {
    schemaVersion: HANDOFF_CONTINUITY_OCCURRENCE_BUNDLE_SCHEMA_VERSION,
    handoffContinuityOccurrences: occurrences,
  };
}

function verifyRow(
  row: UnknownRecord,
  index: number,
  expectedSources: ReadonlyMap<string, PreventionSourceFact>,
  expectations: ReadonlyMap<string, PreventionIncidentExpectation>,
  referencedSources: Set<string>,
  sourceRefsByIncident: Map<string, Set<string>>,
  violations: string[],
): void {
  const label = `row-${index}`;
  exactKeys(row, [
    "id", "title", "sourceRefs", "classifications", "classRationales", "centralizedOwner", "boundary",
    "hostileRegression", "applicability", "remainingClosureEvidence", "claimLimits",
    "researchQualificationPath", "prevention", "review",
  ], label, violations);
  const id = nonEmptyString(row.id, `${label}-id`, violations);
  nonEmptyString(row.title, `${label}-title`, violations);
  const sourceRefs = stringArray(row.sourceRefs, `${label}-source-refs`, violations);
  const classes = stringArray(row.classifications, `${label}-classifications`, violations);
  if (sourceRefs !== undefined) {
    for (const sourceId of sourceRefs) {
      const source = expectedSources.get(sourceId);
      if (source === undefined) violations.push(`row-source-unknown:${id ?? label}:${sourceId}`);
      else {
        referencedSources.add(sourceId);
        if (id !== undefined && !source.incidentIds.includes(id)) {
          violations.push(`row-source-incident-mismatch:${id}:${sourceId}`);
        }
      }
    }
    if (id !== undefined) {
      sourceRefsByIncident.set(id, new Set(sourceRefs));
    }
  }
  if (classes !== undefined) {
    for (const classification of classes) {
      if (!CLASS_SET.has(classification)) violations.push(`row-class-invalid:${id ?? label}:${classification}`);
    }
    const expected = id === undefined ? undefined : expectations.get(id);
    if (expected !== undefined && canonicalStrings(classes) !== canonicalStrings(expected.classifications)) {
      violations.push(`row-classification-false-or-drifted:${id}`);
    }
  }
  verifyClassRationales(row.classRationales, classes, id ?? label, violations);
  verifyOwner(row.centralizedOwner, id ?? label, violations);
  verifyBoundary(row.boundary, id ?? label, violations);
  verifyRegression(row.hostileRegression, id ?? label, violations);
  verifyApplicability(row.applicability, id ?? label, violations);
  stringArray(row.remainingClosureEvidence, `${label}-remaining-closure-evidence`, violations);
  stringArray(row.claimLimits, `${label}-claim-limits`, violations);
  stringArray(row.researchQualificationPath, `${label}-research-qualification-path`, violations);
  verifyPrevention(row.prevention, classes, id ?? label, violations);
  verifyReview(row.review, id ?? label, violations);
  verifyClosureSemantics(row, classes, id ?? label, violations);
}

function verifyClassRationales(
  value: unknown,
  classes: readonly string[] | undefined,
  id: string,
  violations: string[],
): void {
  const rationales = array(value, `${id}-class-rationales`, violations);
  if (rationales === undefined) return;
  const seen = new Set<string>();
  for (const [index, candidate] of rationales.entries()) {
    const entry = record(candidate, `${id}-class-rationale-${index}`, violations);
    if (entry === undefined) continue;
    exactKeys(entry, ["class", "rationale"], `${id}-class-rationale-${index}`, violations);
    const classification = nonEmptyString(entry.class, `${id}-class-rationale-${index}-class`, violations);
    nonEmptyString(entry.rationale, `${id}-class-rationale-${index}-rationale`, violations);
    if (classification !== undefined) {
      if (seen.has(classification)) violations.push(`row-class-rationale-duplicate:${id}:${classification}`);
      seen.add(classification);
    }
  }
  if (classes !== undefined && canonicalStrings(seen) !== canonicalStrings(classes)) {
    violations.push(`row-class-rationale-mismatch:${id}`);
  }
}

function verifyOwner(value: unknown, id: string, violations: string[]): void {
  const owner = record(value, `${id}-owner`, violations);
  if (owner === undefined) return;
  exactKeys(owner, ["ownerId", "reuseTargets"], `${id}-owner`, violations);
  nonEmptyString(owner.ownerId, `${id}-owner-id`, violations);
  const targets = stringArray(owner.reuseTargets, `${id}-reuse-targets`, violations);
  if (targets?.every((target) => /model|llm|agent vigilance/iu.test(target)) === true) {
    violations.push(`model-vigilance-only-disposition:${id}`);
  }
}

function verifyBoundary(value: unknown, id: string, violations: string[]): void {
  const boundary = record(value, `${id}-boundary`, violations);
  if (boundary === undefined) return;
  exactKeys(boundary, ["type", "checkpoints"], `${id}-boundary`, violations);
  const type = nonEmptyString(boundary.type, `${id}-boundary-type`, violations);
  if (type !== undefined && !BOUNDARIES.has(type)) violations.push(`row-boundary-invalid:${id}`);
  stringArray(boundary.checkpoints, `${id}-boundary-checkpoints`, violations);
}

function verifyRegression(value: unknown, id: string, violations: string[]): void {
  const regression = record(value, `${id}-regression`, violations);
  if (regression === undefined) return;
  exactKeys(regression, ["id", "minimumRepeatedRuns", "minimumDistinctScenarios", "cases"], `${id}-regression`, violations);
  nonEmptyString(regression.id, `${id}-regression-id`, violations);
  if (!Number.isInteger(regression.minimumRepeatedRuns) || Number(regression.minimumRepeatedRuns) < 3) {
    violations.push(`row-regression-repetitions-below-three:${id}`);
  }
  if (!Number.isInteger(regression.minimumDistinctScenarios) || Number(regression.minimumDistinctScenarios) < 3) {
    violations.push(`row-regression-distinct-scenarios-below-three:${id}`);
  }
  stringArray(regression.cases, `${id}-regression-cases`, violations);
}

function verifyApplicability(value: unknown, id: string, violations: string[]): void {
  const applicability = record(value, `${id}-applicability`, violations);
  if (applicability === undefined) return;
  exactKeys(applicability, ["modules", "languages", "surfaces"], `${id}-applicability`, violations);
  stringArray(applicability.modules, `${id}-applicability-modules`, violations);
  stringArray(applicability.languages, `${id}-applicability-languages`, violations);
  stringArray(applicability.surfaces, `${id}-applicability-surfaces`, violations);
}

function verifyPrevention(
  value: unknown,
  classes: readonly string[] | undefined,
  id: string,
  violations: string[],
): void {
  const prevention = record(value, `${id}-prevention`, violations);
  if (prevention === undefined) return;
  exactKeys(prevention, ["status", "preventedScope", "modelVigilanceRole"], `${id}-prevention`, violations);
  const status = nonEmptyString(prevention.status, `${id}-prevention-status`, violations);
  if (status !== undefined && !PREVENTION_STATES.has(status)) violations.push(`row-prevention-status-invalid:${id}`);
  const scope = stringArray(prevention.preventedScope, `${id}-prevented-scope`, violations, true);
  if (prevention.modelVigilanceRole !== MODEL_ROLE) violations.push(`model-vigilance-role-authoritative:${id}`);
  const centrallyPrevented = classes?.includes("centrally-prevented-narrowly") === true;
  if (centrallyPrevented && status !== "implemented-narrow-boundary") {
    violations.push(`false-central-prevention-status:${id}`);
  }
  if (centrallyPrevented && (scope === undefined || scope.length === 0)) {
    violations.push(`false-central-prevention-empty-scope:${id}`);
  }
  if (!centrallyPrevented && status === "implemented-narrow-boundary") {
    violations.push(`false-central-prevention-class:${id}`);
  }
}

function verifyReview(value: unknown, id: string, violations: string[]): void {
  const review = record(value, `${id}-review`, violations);
  if (review === undefined) return;
  exactKeys(review, ["state", "authorActorId", "reviewerActorId"], `${id}-review`, violations);
  const state = nonEmptyString(review.state, `${id}-review-state`, violations);
  const author = nonEmptyString(review.authorActorId, `${id}-review-author`, violations);
  if (state !== undefined && !REVIEW_STATES.has(state)) violations.push(`row-review-state-invalid:${id}`);
  if (state === "recorded-unreviewed") {
    if (review.reviewerActorId !== null) violations.push(`row-unreviewed-has-reviewer:${id}`);
    return;
  }
  const reviewer = nonEmptyString(review.reviewerActorId, `${id}-reviewer`, violations);
  if (author !== undefined && reviewer === author) violations.push(`row-self-approved:${id}`);
}

function verifyClosureSemantics(
  row: UnknownRecord,
  classes: readonly string[] | undefined,
  id: string,
  violations: string[],
): void {
  const review = typeof row.review === "object" && row.review !== null && !Array.isArray(row.review)
    ? row.review as UnknownRecord : undefined;
  if (review?.state !== "closed") return;
  const prevention = typeof row.prevention === "object" && row.prevention !== null && !Array.isArray(row.prevention)
    ? row.prevention as UnknownRecord : undefined;
  const remaining = Array.isArray(row.remainingClosureEvidence) ? row.remainingClosureEvidence : undefined;
  if (classes === undefined || canonicalStrings(classes) !== canonicalStrings(["centrally-prevented-narrowly"]) ||
    prevention?.status !== "implemented-narrow-boundary" ||
    remaining?.length !== 1 || remaining[0] !== "none") {
    violations.push(`row-closed-with-open-prevention-or-evidence:${id}`);
  }
}

function record(value: unknown, label: string, violations: string[]): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    violations.push(`${label}-must-be-object`);
    return undefined;
  }
  return value as UnknownRecord;
}

function array(value: unknown, label: string, violations: string[]): readonly unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    violations.push(`${label}-must-be-nonempty-array`);
    return undefined;
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  violations: string[],
  allowEmpty = false,
): readonly string[] | undefined {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    violations.push(`${label}-must-be-${allowEmpty ? "string" : "nonempty-string"}-array`);
    return undefined;
  }
  const entries = value as string[];
  if (new Set(entries).size !== entries.length) violations.push(`${label}-contains-duplicates`);
  return entries;
}

function nonEmptyString(value: unknown, label: string, violations: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    violations.push(`${label}-must-be-nonempty-string`);
    return undefined;
  }
  return value;
}

function exactKeys(value: UnknownRecord, expected: readonly string[], label: string, violations: string[]): void {
  const actual = Object.keys(value).toSorted();
  if (canonicalStrings(actual) !== canonicalStrings(expected)) violations.push(`${label}-keys-invalid`);
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  violation: string,
  violations: string[],
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    if (result.has(id)) violations.push(`${violation}:${id}`);
    else result.set(id, value);
  }
  return result;
}

function canonicalSource(source: PreventionSourceFact): string {
  return JSON.stringify({ ...source, incidentIds: [...source.incidentIds].toSorted() });
}

function canonicalStrings(values: Iterable<string>): string {
  return JSON.stringify([...values].toSorted());
}

function result(violations: string[]): PreventionReviewResult {
  const unique = [...new Set(violations)].toSorted();
  return { valid: unique.length === 0, violations: unique };
}
