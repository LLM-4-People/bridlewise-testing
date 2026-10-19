import { z } from "zod";
import type { GateOutcome } from "../../src/shared/budget-verdict.ts";
import { failureDigest, failureIdentityFile, failureLocation, skippedIdentity } from "../../src/shared/run-history.ts";
import { TEST_RESULT_ERROR_SCHEMA, testErrorStatement } from "../../src/workflow/test-result-collector.ts";

import {
  parseTestInventoryDocument,
  type TestInventory,
} from "../test-inventory.ts";
import {
  CANDIDATE_MANIFEST_SCHEMA_VERSION,
  type CandidateTestIdentity,
} from "./candidate-manifest.ts";
import { TEST_SURFACE_SCOPE_SCHEMA } from "../verification/test-surface.ts";
import {
  canonicalHash,
  canonicalJson,
  deepFreeze,
  sha256,
  type DeepReadonly,
} from "../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { snapshotJsonValue } from "../../src/kernel/safe-structural.ts";
import { sameOrderedValues } from "../../src/kernel/ordered.ts";

const COUNTS_SCHEMA = z.strictObject({
  discovered: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  todo: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
});

export const TEST_RUN_REASON_CODES = [
  "runner-summary-missing",
  "runner-summary-duplicate",
  "runner-summary-unsuccessful",
  "runner-summary-counts-invalid",
  "runner-summary-counts-mismatch",
  "candidate-identity-changed",
  "lifecycle-invalid",
  "inventory-incomplete-discovery",
  "inventory-incomplete-pass",
  "test-failure",
  "test-skipped",
  "test-todo",
  "test-cancelled",
] as const;
const TEST_RUN_REASON_SCHEMA = z.enum(TEST_RUN_REASON_CODES);

const TEST_RECEIPT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.receipts.testExecution.testReceiptSchemaVersion),
  integrityClaim: z.literal("self-integrity-only-not-authenticity"),
  candidate: z.strictObject({
    manifestSchemaVersion: z.literal(CANDIDATE_MANIFEST_SCHEMA_VERSION),
    formatPolicyRevision: z.literal(ROOT_POLICY.verification.candidateFormat.revision),
    semanticTreeHash: z.string().regex(/^[0-9a-f]{64}$/u),
    formatVerificationHash: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  inventoryHash: z.string().regex(/^[0-9a-f]{64}$/u),
  inventoryScope: TEST_SURFACE_SCOPE_SCHEMA,
  inventory: z.array(z.unknown()).min(1),
  discoveredTestIds: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
  passedTestIds: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
  counts: COUNTS_SCHEMA,
  gatedTestIds: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
  /**
   * Files that failed at module load. Recorded so the terminal-count identity
   * reconciles the one legitimate overhang (a crashed file counts in `failed`
   * but contributes no inventory id to `discovered`). Defaults to 0 on parse
   * so receipts written before the field existed still validate.
   */
  loadCrashCount: z.number().int().nonnegative().default(0),
  /**
   * Files the suite watchdog killed: node counts each as one more (aborted)
   * file-level test with no inventory id, the same kind of overhang as a load
   * crash. Written only when non-zero, so every earlier receipt keeps its bytes
   * and its integrity hash.
   */
  abortedFileCount: z.number().int().positive().optional(),
  integrityHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export const TEST_FAILURE_DETAIL_SCHEMA = z.strictObject({
  identity: z.string(),
  file: z.string().nullable(),
  line: z.number().int().nonnegative().nullable(),
  column: z.number().int().nonnegative().nullable(),
  error: TEST_RESULT_ERROR_SCHEMA.nullable(),
});
export type TestFailureDetail = DeepReadonly<z.infer<typeof TEST_FAILURE_DETAIL_SCHEMA>>;

/**
 * A SKIPPED TEST, NAMED: `<file>::<name>` like a failure, with the reason it
 * gave. A skip is a test that did not pass; naming it lets the workspace's
 * ledger judge compare it like for like with the target's run (a new skip is
 * refused, a persisting one needs its owning task) instead of every skip
 * failing every run. Withheld (gated) tests are not here:
 * nothing dispatched them, and they stay an independent refusal.
 */
export const TEST_SKIP_SCHEMA = z.strictObject({ identity: z.string().min(1), reason: z.string() });
export type TestSkip = DeepReadonly<z.infer<typeof TEST_SKIP_SCHEMA>>;

const TEST_RUN_DIAGNOSTIC_SCHEMA = z.strictObject({
  error: z.literal("test_run_failed"),
  reasons: z.array(TEST_RUN_REASON_SCHEMA).min(1),
  failures: z.array(z.string()),
  failureDetails: z.array(TEST_FAILURE_DETAIL_SCHEMA).optional(),
  // Absent on receipts written before skips were named: their skips stay an
  // independent refusal (nothing names them, so nothing can judge them).
  skips: z.array(TEST_SKIP_SCHEMA).optional(),
  unknownTests: z.array(z.string()),
});

const TEST_RUNNER_SUMMARY_COUNTS_SCHEMA = z.strictObject({
  tests: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  todo: z.number().int().nonnegative(),
});

const TEST_RUNNER_SUMMARY_SCHEMA = z.strictObject({
  eventCount: z.number().int().nonnegative(),
  successful: z.boolean(),
  counts: TEST_RUNNER_SUMMARY_COUNTS_SCHEMA.nullable(),
});

const TEST_RESULT_RECEIPT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.receipts.testExecution.resultSchemaVersion),
  integrityClaim: z.literal("self-integrity-only-not-authenticity"),
  testReceipt: TEST_RECEIPT_SCHEMA,
  result: z.strictObject({
    status: z.enum(["passed", "failed"]),
    exitCode: z.union([z.literal(0), z.literal(1)]),
    runnerSummary: TEST_RUNNER_SUMMARY_SCHEMA,
    candidateAfterExecution: TEST_RECEIPT_SCHEMA.shape.candidate,
    diagnostic: TEST_RUN_DIAGNOSTIC_SCHEMA.nullable(),
  }),
  integrityHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

export type TestCounts = DeepReadonly<z.infer<typeof COUNTS_SCHEMA>>;
export type TestRunReason = typeof TEST_RUN_REASON_CODES[number];
export type TestRunnerSummary = DeepReadonly<z.infer<typeof TEST_RUNNER_SUMMARY_SCHEMA>>;
export type TestRunReasonFacts = Readonly<{
  expectedCount: number;
  runnerSummary: TestRunnerSummary;
  discoveredCount: number;
  passedCount: number;
  counts: TestCounts;
  unknownTestsCount: number;
  candidateIdentityComparison: "changed" | "not-evaluated" | "same";
  /**
   * Entries that were withheld from dispatch. They are expected, discovered
   * and skipped like any other entry, but the test runner never saw them, so
   * its own summary is compared against `expectedCount - withheldCount`.
   * Without this the runner would be blamed for a mismatch it did not cause,
   * and "the runner disagreed" would mask "tests were withheld" — the two
   * things a reader most needs told apart. Defaults to 0: a run with nothing
   * withheld compares exactly as before.
   */
  withheldCount?: number;
}>;
export type TestReceipt = DeepReadonly<z.infer<typeof TEST_RECEIPT_SCHEMA>>;
export type TestRunDiagnostic = DeepReadonly<z.infer<typeof TEST_RUN_DIAGNOSTIC_SCHEMA>>;
export type TestResultReceipt = DeepReadonly<z.infer<typeof TEST_RESULT_RECEIPT_SCHEMA>>;

export function createTestReceipt(
  candidate: CandidateTestIdentity,
  inventory: TestInventory,
  discoveredTestIds: readonly string[],
  passedTestIds: readonly string[],
  counts: TestCounts,
  gatedTestIds?: readonly string[],
  loadCrashCount = 0,
  abortedFileCount = 0,
): TestReceipt {
  const validatedInventory = parseTestInventoryDocument(inventory);
  const validatedCounts = COUNTS_SCHEMA.parse(counts);
  assertObservedTestIds(validatedInventory, discoveredTestIds, passedTestIds, validatedCounts, loadCrashCount + abortedFileCount);
  const unsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.testReceiptSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    candidate,
    inventoryHash: validatedInventory.inventoryHash,
    inventoryScope: validatedInventory.scope,
    inventory: [...validatedInventory.tests],
    discoveredTestIds: [...discoveredTestIds],
    passedTestIds: [...passedTestIds],
    counts: validatedCounts,
    gatedTestIds: [...(gatedTestIds ?? [])],
    loadCrashCount,
    ...(abortedFileCount > 0 ? { abortedFileCount } : {}),
  } as const;
  return parseTestReceiptValue({ ...unsigned, integrityHash: canonicalHash(unsigned) });
}

export function createTestResultReceipt(
  testReceipt: TestReceipt,
  runnerSummary: TestRunnerSummary,
  candidateAfterExecution: CandidateTestIdentity,
  failures: readonly string[],
  unknownTests: readonly string[],
  failureDetails?: readonly TestFailureDetail[],
  skips?: readonly TestSkip[],
): TestResultReceipt {
  assertTestFailureDetails(failures, failureDetails);
  const validatedTestReceipt = parseTestReceiptValue(testReceipt);
  const validatedRunnerSummary = TEST_RUNNER_SUMMARY_SCHEMA.parse(runnerSummary);
  assertRunnerSummaryConsistency(validatedRunnerSummary);
  if (failures.length !== validatedTestReceipt.counts.failed + validatedTestReceipt.counts.cancelled) throw new Error("test result accounting is invalid");
  // Accounted by the parse that ends this function (assertTestResultConsistency).
  const sortedSkips = skips === undefined ? undefined : [...skips].toSorted((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0);
  const reasons = deriveTestRunReasons(testRunReasonFacts(
    validatedTestReceipt,
    validatedRunnerSummary,
    unknownTests.length,
    candidateAfterExecution,
  ));
  const passed = testReceiptIsPassing(validatedTestReceipt) && reasons.length === 0;
  const diagnostic: TestRunDiagnostic | null = passed ? null : {
    error: "test_run_failed",
    reasons: [...reasons],
    failures: [...failures].toSorted(),
    ...(failureDetails === undefined ? {} : { failureDetails: [...failureDetails] }),
    ...(sortedSkips === undefined ? {} : { skips: sortedSkips }),
    unknownTests: [...unknownTests].toSorted(),
  };
  const unsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.resultSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    testReceipt: validatedTestReceipt,
    result: {
      status: passed ? "passed" : "failed",
      exitCode: passed ? 0 : 1,
      runnerSummary: validatedRunnerSummary,
      candidateAfterExecution,
      diagnostic,
    },
  } as const;
  return parseTestResultReceiptValue({ ...unsigned, integrityHash: canonicalHash(unsigned) });
}

export function computeTestResultReceiptDeterministicHash(receipt: TestResultReceipt): string {
  // Deterministic hash: excludes candidate worktree state (which the runner
  // itself mutates via tracked-file writes) and runner-summary event counts
  // (which are stable but derived). Covers the test identity (discovered and
  // passed test IDs), counts, overall status, and diagnostic (reasons,
  // failures, unknownTests) — all of which are stable across two runs of the
  // same test suite with the same outcomes.
  const input = {
    discoveredTestIds: receipt.testReceipt.discoveredTestIds,
    passedTestIds: receipt.testReceipt.passedTestIds,
    counts: receipt.testReceipt.counts,
    status: receipt.result.status,
    ...(receipt.result.diagnostic === null ? {} : {
      reasons: receipt.result.diagnostic.reasons,
      failures: receipt.result.diagnostic.failures,
      unknownTests: receipt.result.diagnostic.unknownTests,
    }),
  };
  return sha256(canonicalJson(input));
}

export function deriveTestRunReasons(facts: TestRunReasonFacts): readonly TestRunReason[] {
  const observed = new Set<TestRunReason>();
  if (facts.runnerSummary.eventCount === 0) observed.add("runner-summary-missing");
  if (facts.runnerSummary.eventCount > 1) observed.add("runner-summary-duplicate");
  if (facts.runnerSummary.eventCount > 0 && !facts.runnerSummary.successful) {
    observed.add("runner-summary-unsuccessful");
  }
  if (facts.runnerSummary.eventCount === 1 && facts.runnerSummary.counts === null) {
    observed.add("runner-summary-counts-invalid");
  }
  if (facts.runnerSummary.counts !== null && !runnerSummaryMatches(facts)) {
    observed.add("runner-summary-counts-mismatch");
  }
  if (facts.candidateIdentityComparison === "changed") observed.add("candidate-identity-changed");
  if (facts.unknownTestsCount > 0) observed.add("lifecycle-invalid");
  if (facts.discoveredCount !== facts.expectedCount) observed.add("inventory-incomplete-discovery");
  if (facts.passedCount !== facts.expectedCount) observed.add("inventory-incomplete-pass");
  if (facts.counts.failed > 0) observed.add("test-failure");
  if (facts.counts.skipped > 0) observed.add("test-skipped");
  if (facts.counts.todo > 0) observed.add("test-todo");
  if (facts.counts.cancelled > 0) observed.add("test-cancelled");
  return Object.freeze(TEST_RUN_REASON_CODES.filter((reason) => observed.has(reason)));
}

/**
 * THE LEDGER ROWS OF A RUN: its failures, and its NAMED SKIPS as rows of their
 * own (`<file>::<name> (skipped)`) — a test that did not pass, judged like for
 * like with the target's run beside the failures (a new skip is refused, a
 * persisting one needs its owning task). A failure's digest is its first
 * error; a skip's is its reason, so a skip that skips for another reason now
 * fails differently.
 */
export function testResultLedgerRows(receipt: TestResultReceipt, root: string): Readonly<{
  failures: string[]; failureDigests: Record<string, string>; failureLocations: Record<string, string>;
}> {
  const diagnostic = receipt.result.diagnostic;
  const skips = diagnostic?.skips ?? [];
  return {
    failures: [...(diagnostic?.failures ?? []), ...skips.map((skip) => skippedIdentity(skip.identity))].toSorted(),
    failureDigests: Object.fromEntries([
      ...(diagnostic?.failureDetails ?? []).flatMap((detail) =>
        detail.error === null ? [] : [[detail.identity, failureDigest(detail.error, root)] as const]),
      ...skips.map((skip) => [skippedIdentity(skip.identity), failureDigest({ name: "TestSkipped", message: skip.reason }, root)] as const),
    ]),
    // Where each failure happened, when its error names a frame of its own test file or an operator (a skip has no location).
    failureLocations: Object.fromEntries((diagnostic?.failureDetails ?? []).flatMap((detail) => {
      const file = failureIdentityFile(detail.identity);
      const location = detail.error === null || file === null ? null : failureLocation(testErrorStatement(detail.error), file);
      return location === null ? [] : [[detail.identity, location] as const];
    })),
  };
}

/** Current qualification classifies the validated receipt at its semantic owner.
 * Only complete ordinary case failures and NAMED skips can be explained by a
 * target baseline (the workspace's ledger judge compares their identities like
 * for like and asks each persisting one for its owning task); withheld, todo,
 * cancelled, unnamed skips and independent accounting failures cannot. */
export function testResultQualification(receipt: TestResultReceipt): Readonly<{
  complete: boolean; outcomes: readonly GateOutcome[];
}> {
  const counts = receipt.testReceipt.counts;
  const expected = expectedTestIdsFromReceipt(receipt.testReceipt).length;
  const diagnostic = receipt.result.diagnostic;
  const reasons = diagnostic?.reasons ?? [];
  const complete = counts.discovered === expected && (diagnostic?.unknownTests.length ?? 0) === 0
    && receipt.testReceipt.loadCrashCount === 0 && (receipt.testReceipt.abortedFileCount ?? 0) === 0
    && receipt.result.runnerSummary.eventCount === 1 && receipt.result.runnerSummary.counts !== null;
  const namedSkips = diagnostic?.skips?.length ?? 0;
  const judgedByIdentity = complete && counts.failed + counts.skipped > 0 && counts.passed + counts.failed + counts.skipped === expected
    && counts.skipped === namedSkips && counts.todo === 0 && counts.cancelled === 0 && receipt.testReceipt.gatedTestIds.length === 0
    && diagnostic?.failures.length === counts.failed;
  const outcomes: GateOutcome[] = [];
  for (const reason of reasons) {
    if (judgedByIdentity && (reason === "test-failure" || reason === "test-skipped" || reason === "runner-summary-unsuccessful" || reason === "inventory-incomplete-pass")) continue;
    outcomes.push({ gate: `engine-${reason}`, kind: "fail", message: `test receipt retains independent reason ${reason}` });
  }
  outcomes.push({ gate: "engine-test-results", kind: complete ? "pass" : "fail",
    message: `${String(counts.discovered)}/${String(expected)} discovered; ${String(counts.passed)} passed, ${String(counts.failed)} failed, ${String(counts.skipped)} skipped, ${String(counts.todo)} todo, ${String(counts.cancelled)} cancelled; ${String(receipt.testReceipt.gatedTestIds.length)} withheld; census ${complete ? "complete" : "incomplete"}` });
  return { complete, outcomes };
}

export function parseTestResultReceiptBytes(bytes: Uint8Array): TestResultReceipt {
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0 || buffer.includes(0) || buffer.at(-1) !== 0x0a || buffer.at(-2) === 0x0a) {
    throw new Error("test result receipt framing is invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    if (text.charCodeAt(0) === 0xfeff) throw new Error("bom");
  } catch {
    throw new Error("test result receipt encoding is invalid");
  }
  assertNoDuplicateJsonObjectKeys(text, "Test result receipt has duplicate keys", "test_result_key_duplicate");
  const value = JSON.parse(text) as unknown;
  if (`${canonicalJson(value)}\n` !== text) throw new Error("test result receipt is not canonical");
  return parseTestResultReceiptValue(value);
}

export function parseTestResultReceiptValue(value: unknown): TestResultReceipt {
  const parsed = TEST_RESULT_RECEIPT_SCHEMA.parse(value);
  const { integrityHash, ...unsigned } = parsed;
  if (canonicalHash(unsigned) !== integrityHash) throw new Error("test result receipt integrity is invalid");
  const testReceipt = parseTestReceiptValue(parsed.testReceipt);
  assertTestResultConsistency(testReceipt, parsed.result);
  return deepFreeze(parsed) as TestResultReceipt;
}

export function validateTestReceipt(
  value: unknown,
  expectedCandidate: CandidateTestIdentity,
  expectedInventory: TestInventory,
): readonly string[] {
  let snapshot: unknown;
  try {
    snapshot = snapshotJsonValue(value, {
      maximumDepth: ROOT_POLICY.forensics.limits.maximumDepth,
      maximumNodes: ROOT_POLICY.forensics.limits.maximumNodes,
    }, "test_receipt_structure_invalid");
  } catch {
    return ["test-receipt-schema-invalid"];
  }
  const parsedRun = TEST_RESULT_RECEIPT_SCHEMA.safeParse(snapshot);
  if (!parsedRun.success) return ["test-result-receipt-schema-invalid"];
  const runReceipt = parsedRun.data;
  try {
    parseEmbeddedTestInventory(runReceipt.testReceipt);
  } catch {
    return ["test-result-receipt-schema-invalid"];
  }
  const { integrityHash: runIntegrityHash, ...unsignedRun } = runReceipt;
  const runViolations: string[] = [];
  if (canonicalHash(unsignedRun) !== runIntegrityHash) runViolations.push("test-result-receipt-integrity-invalid");
  if (runReceipt.result.status !== "passed" || runReceipt.result.exitCode !== 0 ||
    runReceipt.result.diagnostic !== null) {
    runViolations.push("test-result-receipt-nonpassing-result");
  }
  const parsed = TEST_RECEIPT_SCHEMA.safeParse(runReceipt.testReceipt);
  if (!parsed.success) return ["test-receipt-schema-invalid"];
  const receipt = parsed.data;
  const { integrityHash, ...unsigned } = receipt;
  const expectedIds = expectedInventory.tests.map((entry) => entry.id);
  const violations: string[] = [];
  if (canonicalHash(unsigned) !== integrityHash) violations.push("test-receipt-integrity-invalid");
  if (canonicalHash(receipt.candidate) !== canonicalHash(expectedCandidate)) {
    violations.push("test-receipt-candidate-mismatch");
  }
  if (receipt.inventoryHash !== expectedInventory.inventoryHash ||
    canonicalHash(receipt.inventoryScope) !== canonicalHash(expectedInventory.scope) ||
    canonicalHash(receipt.inventory) !== canonicalHash(expectedInventory.tests)) {
    violations.push("test-receipt-inventory-mismatch");
  }
  if (!sameOrderedValues(receipt.discoveredTestIds, expectedIds)) violations.push("test-receipt-discovered-inventory");
  if (!sameOrderedValues(receipt.passedTestIds, expectedIds)) violations.push("test-receipt-passed-inventory");
  const expectedCount = expectedInventory.tests.length;
  if (receipt.counts.discovered !== expectedCount || receipt.counts.passed !== expectedCount ||
    receipt.counts.failed !== 0 || receipt.counts.skipped !== 0 || receipt.counts.todo !== 0 ||
    receipt.counts.cancelled !== 0) {
    violations.push("test-receipt-nonpassing-counts");
  }
  return [...runViolations, ...violations].toSorted();
}

function parseEmbeddedTestInventory(receipt: Readonly<{
  inventoryHash: string;
  inventoryScope: TestInventory["scope"];
  inventory: readonly unknown[];
}>): TestInventory {
  return parseTestInventoryDocument({
    schemaVersion: ROOT_POLICY.verification.testInventorySchema,
    scope: receipt.inventoryScope,
    tests: receipt.inventory,
    inventoryHash: receipt.inventoryHash,
  });
}

function parseTestReceiptValue(value: unknown): TestReceipt {
  const parsed = TEST_RECEIPT_SCHEMA.parse(value);
  const { integrityHash, ...unsigned } = parsed;
  if (canonicalHash(unsigned) !== integrityHash) throw new Error("test receipt integrity is invalid");
  const inventory = parseEmbeddedTestInventory(parsed);
  assertObservedTestIds(inventory, parsed.discoveredTestIds, parsed.passedTestIds, parsed.counts, parsed.loadCrashCount + (parsed.abortedFileCount ?? 0));
  return deepFreeze(parsed) as TestReceipt;
}

function assertObservedTestIds(
  inventory: TestInventory,
  discoveredTestIds: readonly string[],
  passedTestIds: readonly string[],
  counts: TestCounts,
  /** The file-level terminals with no inventory id: load crashes plus watchdog-killed files. */
  fileLevelTerminals = 0,
): void {
  // The expected set is the WHOLE inventory. It used to be the inventory MINUS
  // the gated ids, which is the same subtraction the accountant used to make
  // and the same one that let a shrunken run validate as complete — the second
  // copy of one defect, in the instrument that exists to catch it. A gated
  // entry now arrives as discovered-and-skipped, so it is present here and the
  // skipped count is what refuses the run.
  const expectedIds = inventory.tests.map((entry) => entry.id);
  const inventoryIds = new Set(expectedIds);
  const discoveredIds = new Set(discoveredTestIds);
  const passedIds = new Set(passedTestIds);
  const terminalCount = counts.passed + counts.failed + counts.skipped + counts.todo + counts.cancelled;
  // A MODULE-LOAD CRASH is the one legitimate place `terminalCount` exceeds
  // the inventory-id `discovered` count: node counts the crashed file as one
  // failed test, and the accountant names that crash in `failed`, but the
  // file's real tests never enqueued so it contributes no inventory id to
  // `discovered`. The crash count is the EXACT overhang — subtracting it
  // (never a blanket tolerance) restores the identity, so a run with crashed
  // files reports its named failures instead of crashing here and hiding them.
  if (discoveredIds.size !== discoveredTestIds.length || passedIds.size !== passedTestIds.length ||
    discoveredTestIds.some((id) => !inventoryIds.has(id)) ||
    passedTestIds.some((id) => !discoveredIds.has(id)) ||
    counts.discovered !== discoveredTestIds.length || counts.passed !== passedTestIds.length ||
    terminalCount - fileLevelTerminals !== counts.discovered) {
    throw new Error("test receipt accounting is invalid");
  }
}

function expectedTestIdsFromReceipt(receipt: TestReceipt): readonly string[] {
  // Every inventoried test is expected, with no exception for the gated ones.
  // Subtracting them here made `passedTestIds === expectedIds` true of a set
  // the run had quietly narrowed, which is how an incomplete run produced a
  // passing receipt. `gatedTestIds` remains on the receipt as the RECORD of
  // what was withheld; it is no longer permitted to redefine what was owed.
  const inventory = parseEmbeddedTestInventory(receipt);
  return inventory.tests.map((entry) => entry.id);
}

function testReceiptIsPassing(receipt: TestReceipt): boolean {
  const expectedIds = expectedTestIdsFromReceipt(receipt);
  return sameOrderedValues(receipt.discoveredTestIds, expectedIds) &&
    sameOrderedValues(receipt.passedTestIds, expectedIds) &&
    receipt.counts.discovered === expectedIds.length && receipt.counts.passed === expectedIds.length &&
    receipt.counts.failed === 0 && receipt.counts.skipped === 0 && receipt.counts.todo === 0 &&
    receipt.counts.cancelled === 0;
}

function testRunReasonFacts(
  receipt: TestReceipt,
  runnerSummary: TestRunnerSummary,
  unknownTestsCount: number,
  candidateAfterExecution: CandidateTestIdentity,
): TestRunReasonFacts {
  return {
    expectedCount: expectedTestIdsFromReceipt(receipt).length,
    runnerSummary,
    discoveredCount: receipt.discoveredTestIds.length,
    passedCount: receipt.passedTestIds.length,
    counts: receipt.counts,
    withheldCount: receipt.gatedTestIds.length,
    unknownTestsCount,
    candidateIdentityComparison: canonicalHash(receipt.candidate) === canonicalHash(candidateAfterExecution)
      ? "same"
      : "changed",
  };
}

function assertRunnerSummaryConsistency(summary: TestRunnerSummary): void {
  const unique = summary.eventCount === 1;
  if ((!unique && (summary.successful || summary.counts !== null)) ||
    (summary.successful && (summary.counts === null || summary.counts.failed > 0 ||
      summary.counts.cancelled > 0))) {
    throw new Error("test runner summary accounting is invalid");
  }
}

function runnerSummaryMatches(facts: TestRunReasonFacts): boolean {
  const summary = facts.runnerSummary.counts;
  const withheld = facts.withheldCount ?? 0;
  return summary !== null && summary.tests === facts.expectedCount - withheld &&
    summary.failed === facts.counts.failed && summary.passed === facts.passedCount &&
    summary.cancelled === facts.counts.cancelled && summary.skipped === facts.counts.skipped - withheld &&
    summary.todo === facts.counts.todo;
}

/** The named skips account for every dispatched skip exactly once (the withheld are counted skipped but never dispatched). */
function assertTestSkips(skips: readonly TestSkip[], receipt: TestReceipt): void {
  const parsed = z.array(TEST_SKIP_SCHEMA).parse(skips);
  if (parsed.length !== receipt.counts.skipped - receipt.gatedTestIds.length
    || !sameOrderedValues(parsed.map((skip) => skip.identity), [...new Set(parsed.map((skip) => skip.identity))].toSorted())) {
    throw new Error("test result accounting is invalid");
  }
}

function assertTestFailureDetails(failures: readonly string[], failureDetails: readonly TestFailureDetail[] | undefined): void {
  if (failureDetails !== undefined && (failureDetails.length !== failures.length ||
    failureDetails.some((detail) => !failures.includes(detail.identity)) ||
    new Set(failureDetails.map((detail) => detail.identity)).size !== failureDetails.length)) {
    throw new Error("test failure detail accounting is invalid");
  }
}

function assertTestResultConsistency(
  receipt: TestReceipt,
  result: Readonly<{
    status: "passed" | "failed";
    exitCode: 0 | 1;
    runnerSummary: TestRunnerSummary;
    candidateAfterExecution: CandidateTestIdentity;
    diagnostic: TestRunDiagnostic | null;
  }>,
): void {
  assertRunnerSummaryConsistency(result.runnerSummary);
  if (result.diagnostic !== null) {
    assertTestFailureDetails(result.diagnostic.failures, result.diagnostic.failureDetails);
    if (result.diagnostic.skips !== undefined) assertTestSkips(result.diagnostic.skips, receipt);
  }
  const expectedReasons = deriveTestRunReasons(testRunReasonFacts(
    receipt,
    result.runnerSummary,
    result.diagnostic?.unknownTests.length ?? 0,
    result.candidateAfterExecution,
  ));
  if (result.status === "passed") {
    if (result.exitCode !== 0 || result.diagnostic !== null || !testReceiptIsPassing(receipt) ||
      expectedReasons.length !== 0) {
      throw new Error("test result accounting is invalid");
    }
    return;
  }
  if (result.exitCode !== 1 || result.diagnostic === null ||
    result.diagnostic.failures.length !== receipt.counts.failed + receipt.counts.cancelled ||
    !sameOrderedValues(result.diagnostic.failures, [...new Set(result.diagnostic.failures)].toSorted()) ||
    !sameOrderedValues(result.diagnostic.unknownTests, [...new Set(result.diagnostic.unknownTests)].toSorted()) ||
    !sameOrderedValues(result.diagnostic.reasons, expectedReasons)) {
    throw new Error("test result accounting is invalid");
  }
}
