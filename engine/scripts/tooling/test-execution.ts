import { randomUUID } from "node:crypto";
import { arch, hrtime, platform, version } from "node:process";

import { z } from "zod";

import type { RecordedCommandObservation } from "./recorded-command.ts";
import { strictUtf8Text } from "../verification/candidate-format.ts";
import { testResultQualification,
  parseTestResultReceiptBytes,
  parseTestResultReceiptValue,
  type TestResultReceipt,
} from "./test-receipt.ts";
import {
  allocateReceiptAttempt,
  ensureReceiptAuthority,
  isPendingReceiptEntry,
  listReceiptAttemptEntries,
  listReceiptNamespaceEntries,
  readImmutableEvidence,
  writeImmutableEvidence,
  type ReceiptAttempt,
  type ReceiptAuthority,
} from "../../src/filesystem/immutable-receipt.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { canonicalHash, canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys, parseJsonExact } from "../../src/kernel/json-integrity.ts";
import {
  EXECUTION_OPERATION_IDS,
  EXECUTION_OPERATION_SPECS,
  ROOT_POLICY,
  ROOT_POLICY_HASH,
  type ExecutionOperationId,
} from "../../src/kernel/root-policy.ts";
import { isOwnedTemporaryLive } from "../../src/filesystem/private-state.ts";
import { describeSchemaIssues, HarnessError, hasErrorCode, InputError } from "../../src/kernel/errors.ts";
import { commandTerminalFacts, commandTerminalOutcome, parseCommandTerminalFacts } from "../../src/shared/run-history.ts";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const UUID = z.string().uuid();
const EXECUTION_EVIDENCE_ERROR_CODE = "execution_evidence_invalid";
const REFERENCE_SCHEMA = z.strictObject({
  path: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: SHA256,
  mediaType: z.string().min(1),
  encoding: z.enum(["utf8", "binary"]),
  complete: z.boolean(),
  overflow: z.boolean().optional(),
});
const CONFIG_BINDING_SCHEMA = z.strictObject({
  canonicalHash: SHA256,
  sourceHash: SHA256,
  repositoryManifestHash: SHA256,
});
const START_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.receipts.testExecution.startSchemaVersion),
  integrityClaim: z.literal("self-integrity-only-not-authenticity"),
  attemptId: UUID,
  operation: z.enum(EXECUTION_OPERATION_IDS),
  startedAt: z.string().datetime(),
  command: z.array(z.string()).min(1),
  runtime: z.strictObject({ node: z.string(), platform: z.string(), architecture: z.string() }),
  config: CONFIG_BINDING_SCHEMA,
  authority: z.strictObject({
    authorityHash: SHA256,
    relativeRoot: z.string().min(1),
    stage: z.literal("durable-local-creation-unadmitted"),
  }),
  policy: z.strictObject({
    rootPolicyHash: SHA256,
    repositoryArtifactAdmitted: z.literal(false),
    canonicalLedgerAdmitted: z.literal(false),
    releaseReadinessEvidenceAllowed: z.literal(false),
    findingRemovalEvidenceAllowed: z.literal(false),
  }),
  integrityHash: SHA256,
});
const NATIVE_TERMINAL_SCHEMA = z.unknown().transform((value, context) => {
  const facts = parseCommandTerminalFacts(value);
  if (facts !== undefined) return facts;
  context.addIssue({ code: "custom", message: "native command terminal facts invalid" });
  return z.NEVER;
}).nullable();
const TERMINAL_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.receipts.testExecution.terminalSchemaVersion),
  integrityClaim: z.literal("self-integrity-only-not-authenticity"),
  attemptId: UUID,
  operation: z.enum(EXECUTION_OPERATION_IDS),
  start: z.strictObject({ path: z.string().min(1), sha256: SHA256 }),
  endedAt: z.string().datetime(),
  durationNanoseconds: z.string().regex(/^\d+$/u),
  config: CONFIG_BINDING_SCHEMA,
  policy: z.strictObject({ rootPolicyHash: SHA256 }),
  outcome: z.enum(["passed", "failed", "runner-error", "runner-crash", "setup-failed", "stream-overflow"]),
  errorCode: z.string().nullable(),
  process: z.strictObject({
    spawned: z.boolean(),
    closeObserved: z.boolean(),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    spawnErrorCode: z.string().nullable(),
  }),
  native: NATIVE_TERMINAL_SCHEMA,
  stdout: REFERENCE_SCHEMA,
  stderr: REFERENCE_SCHEMA,
  resultPipe: REFERENCE_SCHEMA,
  result: z.strictObject({
    path: z.string().min(1),
    sha256: SHA256,
    byteLength: z.number().int().nonnegative(),
    schemaVersion: z.union([
      z.literal(ROOT_POLICY.receipts.testExecution.resultSchemaVersion),
      z.literal(ROOT_POLICY.receipts.testExecution.checkResultSchemaVersion),
    ]),
    integrityHash: SHA256,
  }).nullable(),
  integrityHash: SHA256,
});
const CHECK_RESULT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.receipts.testExecution.checkResultSchemaVersion),
  integrityClaim: z.literal("self-integrity-only-not-authenticity"),
  testResultReceipt: z.unknown(),
  verification: z.unknown(),
  result: z.strictObject({ status: z.enum(["passed", "failed"]), exitCode: z.union([z.literal(0), z.literal(1)]) }),
  integrityHash: SHA256,
});

export type ExecutionOperation = ExecutionOperationId;
export const TEST_EXECUTION_OPERATION = registeredOperationForWorkerMode("test");
export const CHECK_EXECUTION_OPERATION = registeredOperationForWorkerMode("check");
export type ExecutionOutcome = z.infer<typeof TERMINAL_SCHEMA>["outcome"];
export type ExecutionConfigBinding = Readonly<z.infer<typeof CONFIG_BINDING_SCHEMA>>;
export type ExecutionAuthority = Readonly<{
  receipt: ReceiptAuthority;
  config: ExecutionConfigBinding;
}>;
export type ExecutionEvidenceReference = Readonly<z.infer<typeof REFERENCE_SCHEMA>>;
export type ExecutionContext = Readonly<{
  authority: ExecutionAuthority;
  attempt: ReceiptAttempt;
  operation: ExecutionOperation;
  startedMonotonicNanoseconds: bigint;
  startPath: string;
  startSha256: string;
}>;
export type CompletedExecution = Readonly<{
  attemptId: string;
  authority: ExecutionAuthority;
  operation: ExecutionOperation;
  outcome: ExecutionOutcome;
  exitCode: 0 | 1;
  result: TestResultReceipt | Readonly<Record<string, unknown>> | null;
  stdout: Buffer;
  stderr: Buffer;
  /** Actual native finality retained by the command adapter. */
  terminal?: RecordedCommandObservation["terminal"];
}>;
export type ExecutionEvidenceScanEntry = Readonly<{
  attemptId: string;
  status: "complete" | "incomplete" | "unsafe" | "ambiguous";
  outcome?: ExecutionOutcome;
  reasonCode?: string;
}>;

export function configuredExecutionAuthority(): ExecutionAuthority {
  const snapshot = loadPinnedConfigSnapshot();
  const relativeRoot = `${snapshot.document.state.root}/${snapshot.document.state.receipts.executionEvidence}`;
  return deepFreeze({
    receipt: ensureReceiptAuthority(snapshot.repositoryRoot, relativeRoot),
    config: {
      canonicalHash: snapshot.canonicalHash,
      sourceHash: snapshot.sourceHash,
      repositoryManifestHash: snapshot.repositoryManifestHash,
    },
  });
}

export function beginRecordedExecution(
  authority: ExecutionAuthority,
  operation: ExecutionOperation,
  command: readonly string[],
  attemptId = randomUUID(),
): ExecutionContext {
  const attempt = allocateReceiptAttempt(authority.receipt, attemptId);
  const startedAt = new Date().toISOString();
  const startedMonotonicNanoseconds = hrtime.bigint();
  const unsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.startSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    attemptId,
    operation,
    startedAt,
    command: [...command],
    runtime: { node: version, platform, architecture: arch },
    config: authority.config,
    authority: {
      authorityHash: authority.receipt.authorityHash,
      relativeRoot: authority.receipt.relativeRoot,
      stage: ROOT_POLICY.receipts.immutableExecution.authorityStage,
    },
    policy: executionAuthorityPolicy(),
  } as const;
  const start = deepFreeze({ ...unsigned, integrityHash: canonicalHash(unsigned) });
  const write = writeImmutableEvidence(authority.receipt, {
    mode: "unique-attempt",
    attempt,
    ordinal: 0,
    label: "start",
    extension: ".json",
    bytes: Buffer.from(`${canonicalJson(start)}\n`, "utf8"),
    contentKind: "canonical-json",
  });
  return Object.freeze({
    authority,
    attempt,
    operation,
    startedMonotonicNanoseconds,
    startPath: write.path,
    startSha256: write.sha256,
  });
}

export function completeRecordedExecution(
  context: ExecutionContext,
  observation: RecordedCommandObservation,
): CompletedExecution {
  const stdout = writeObservedPipe(context, "stdout", observation.stdout, "application/octet-stream", "binary");
  const stderr = writeObservedPipe(context, "stderr", observation.stderr, "application/octet-stream", "binary");
  const parsedResult = parseObservedResult(context.operation, observation.resultPipe.bytes, observation.resultPipe.complete);
  const resultPipe = parsedResult === null
    ? writeObservedPipe(context, "result-pipe", observation.resultPipe, "application/octet-stream", "binary")
    : writeObservedPipe(context, "result", observation.resultPipe, "application/json", "utf8", "results");
  const resultReference = parsedResult === null ? null : {
    path: resultPipe.path,
    sha256: resultPipe.sha256,
    byteLength: resultPipe.byteLength,
    schemaVersion: parsedResult.schemaVersion,
    integrityHash: parsedResult.integrityHash,
  };
  const facts = {
    process: {
      spawned: observation.spawned,
      closeObserved: observation.closeObserved,
      exitCode: observation.exitCode,
      signal: observation.signal,
      spawnErrorCode: observation.spawnErrorCode,
    },
    native: observation.terminal === undefined ? null : commandTerminalFacts(observation.terminal),
    stdout, stderr, resultPipe,
  };
  const decision = decideOutcome(context.operation, facts, parsedResult);
  const unsigned = {
    schemaVersion: ROOT_POLICY.receipts.testExecution.terminalSchemaVersion,
    integrityClaim: "self-integrity-only-not-authenticity",
    attemptId: context.attempt.attemptId,
    operation: context.operation,
    start: { path: context.startPath, sha256: context.startSha256 },
    endedAt: new Date().toISOString(),
    durationNanoseconds: (hrtime.bigint() - context.startedMonotonicNanoseconds).toString(10),
    config: context.authority.config,
    policy: { rootPolicyHash: ROOT_POLICY_HASH },
    outcome: decision.outcome,
    errorCode: decision.errorCode,
    ...facts,
    result: resultReference,
  } as const;
  const terminal = deepFreeze({ ...unsigned, integrityHash: canonicalHash(unsigned) });
  writeImmutableEvidence(context.authority.receipt, {
    mode: "unique-attempt",
    attempt: context.attempt,
    ordinal: 999_999,
    label: "terminal",
    extension: ".json",
    bytes: Buffer.from(`${canonicalJson(terminal)}\n`, "utf8"),
    contentKind: "canonical-json",
  });
  return Object.freeze({
    attemptId: context.attempt.attemptId,
    authority: context.authority,
    operation: context.operation,
    outcome: decision.outcome,
    exitCode: decision.outcome === "passed" ? 0 : 1,
    result: parsedResult,
    stdout: Buffer.from(observation.stdout.bytes),
    stderr: Buffer.from(observation.stderr.bytes),
    ...(observation.terminal === undefined ? {} : { terminal: observation.terminal }),
  });
}

/** A parsed test receipt cannot erase an independent observed execution failure. */
export function testExecutionQualification(execution: CompletedExecution): ReturnType<typeof testResultQualification> {
  if (execution.result === null || execution.result.schemaVersion !== ROOT_POLICY.receipts.testExecution.resultSchemaVersion) {
    return { complete: false, outcomes: [{ gate: "engine-execution", kind: "fail", message: "execution has no validated test result receipt" }] };
  }
  const result = testResultQualification(execution.result as TestResultReceipt);
  if (execution.outcome !== "passed" && execution.outcome !== "failed") {
    return { complete: false, outcomes: [...result.outcomes, { gate: "engine-execution", kind: "fail", message: `independent execution outcome ${execution.outcome}` }] };
  }
  return result;
}

export function loadTestResultFromExecution(
  authority: ReceiptAuthority,
  attemptId: string,
): TestResultReceipt {
  const { terminal, result } = loadValidatedTerminal(authority, attemptId);
  if (executionOperationSpec(terminal.operation).resultKind !== "test-result-receipt" ||
    terminal.outcome !== "passed" || terminal.result === null ||
    terminal.result.schemaVersion !== ROOT_POLICY.receipts.testExecution.resultSchemaVersion) {
    throw new HarnessError("test execution is not a passing complete test result", "execution_result_not_passing");
  }
  // The common loader already parsed and bound this exact result blob.
  return result as TestResultReceipt;
}

export function scanExecutionEvidence(authority: ReceiptAuthority): readonly ExecutionEvidenceScanEntry[] {
  const entries: ExecutionEvidenceScanEntry[] = [];
  let attemptEntries: readonly { name: string; kind: string }[];
  try {
    attemptEntries = listReceiptNamespaceEntries(authority, "attempts");
  } catch {
    return deepFreeze([{ attemptId: "attempts", status: "unsafe", reasonCode: "attempt-root-unsafe" }]);
  }
  for (const entry of attemptEntries) {
    if (entry.kind !== "directory" || !z.string().uuid().safeParse(entry.name).success) {
      entries.push({ attemptId: entry.name, status: "unsafe", reasonCode: "attempt-entry-invalid" });
      continue;
    }
    entries.push(scanAttempt(authority, entry.name));
  }
  return deepFreeze(entries.toSorted((left, right) => left.attemptId.localeCompare(right.attemptId)));
}

function scanAttempt(authority: ReceiptAuthority, attemptId: string): ExecutionEvidenceScanEntry {
  try {
    const { terminal } = loadValidatedTerminal(authority, attemptId);
    return { attemptId, status: "complete", outcome: terminal.outcome };
  } catch (error) {
    if (error instanceof HarnessError && error.code === "execution_attempt_invalid") {
      const { status, reasonCode } = error.safeDetails;
      if ((status === "unsafe" || status === "incomplete" || status === "ambiguous") && typeof reasonCode === "string") {
        return { attemptId, status, reasonCode };
      }
    }
    return { attemptId, status: "unsafe", reasonCode: hasErrorCode(error, "execution_terminal_outcome_invalid")
      ? "terminal-outcome-invalid" : "attempt-schema-or-reference-invalid" };
  }
}

function refuseAttempt(status: Exclude<ExecutionEvidenceScanEntry["status"], "complete">, reasonCode: string): never {
  throw new HarnessError(`execution attempt refused: ${reasonCode}`, "execution_attempt_invalid", false, { status, reasonCode });
}

/** One acceptance path for both the scanner and public successful-result loader. */
function loadValidatedTerminal(authority: ReceiptAuthority, attemptId: string): Readonly<{
  terminal: z.infer<typeof TERMINAL_SCHEMA>; result: ReturnType<typeof parseObservedResult>;
}> {
  let entries: readonly { name: string; kind: string }[];
  try {
    entries = listReceiptAttemptEntries(authority, attemptId);
  } catch {
    return refuseAttempt("unsafe", "attempt-directory-unsafe");
  }
  const pending = entries.filter((entry) => isPendingReceiptEntry(entry.name));
  if (pending.length > 0) {
    // A LIVE writer's pending file is a publication in progress; a dead one's is an orphan.
    const live = pending.some((entry) => isOwnedTemporaryLive(entry.name));
    return refuseAttempt("ambiguous", live ? "publication-in-progress" : "orphan-publication-temporary");
  }
  if (entries.some((entry) => entry.kind !== "file")) return refuseAttempt("unsafe", "attempt-special-entry");
  const starts = entries.filter((entry) => /^000000-start-[0-9a-f]{64}\.json$/u.test(entry.name));
  const terminals = entries.filter((entry) => /^999999-terminal-[0-9a-f]{64}\.json$/u.test(entry.name));
  if (starts.length !== 1 || terminals.length > 1 || starts.length + terminals.length !== entries.length) {
    return refuseAttempt("unsafe", "attempt-event-set-invalid");
  }
  const startPath = `attempts/${attemptId}/${starts[0]!.name}`;
  const startBytes = readImmutableEvidence(authority, startPath, "canonical-json");
  const start = parseCanonicalSchema(startBytes, START_SCHEMA);
  if (start.attemptId !== attemptId || !starts[0]!.name.includes(sha256(startBytes))) {
    return refuseAttempt("unsafe", "start-binding-invalid");
  }
  if (start.authority.authorityHash !== authority.authorityHash || start.authority.relativeRoot !== authority.relativeRoot) {
    return refuseAttempt("unsafe", "start-authority-binding-invalid");
  }
  if (terminals.length === 0) return refuseAttempt("incomplete", "started-without-terminal");
  const terminalEntry = terminals[0]!;
  const terminalPath = `attempts/${attemptId}/${terminalEntry.name}`;
  const terminalBytes = readImmutableEvidence(authority, terminalPath, "canonical-json");
  if (!terminalEntry.name.includes(sha256(terminalBytes))) return refuseAttempt("unsafe", "terminal-filename-binding-invalid");
  const terminal = parseCanonicalSchema(terminalBytes, TERMINAL_SCHEMA);
  if (terminal.attemptId !== attemptId) return refuseAttempt("unsafe", "terminal-attempt-binding-invalid");
  if (terminal.start.path !== startPath || terminal.start.sha256 !== sha256(startBytes) ||
    terminal.operation !== start.operation || canonicalHash(terminal.config) !== canonicalHash(start.config) ||
    terminal.policy.rootPolicyHash !== start.policy.rootPolicyHash) {
    return refuseAttempt("unsafe", "terminal-start-binding-invalid");
  }
  let resultBytes: Buffer | undefined;
  for (const reference of [terminal.stdout, terminal.stderr, terminal.resultPipe]) {
    const bytes = readImmutableEvidence(authority, reference.path, reference.encoding === "utf8" ? "canonical-json" : "blob");
    if (bytes.length !== reference.byteLength || sha256(bytes) !== reference.sha256) {
      return refuseAttempt("unsafe", "terminal-reference-binding-invalid");
    }
    if (reference === terminal.resultPipe) resultBytes = bytes;
  }
  const parsed = parseObservedResult(terminal.operation, resultBytes!, terminal.resultPipe.complete);
  if (terminal.result !== null) {
    if (resultBytes!.length !== terminal.result.byteLength || sha256(resultBytes!) !== terminal.result.sha256 ||
      terminal.result.path !== terminal.resultPipe.path || !terminal.resultPipe.complete) {
      return refuseAttempt("unsafe", "terminal-result-binding-invalid");
    }
    if (parsed === null || parsed.schemaVersion !== terminal.result.schemaVersion ||
      parsed.integrityHash !== terminal.result.integrityHash) {
      return refuseAttempt("unsafe", "terminal-result-schema-binding-invalid");
    }
  } else if (parsed !== null) {
    return refuseAttempt("unsafe", "terminal-result-reference-missing");
  }
  const decision = decideOutcome(terminal.operation, terminal, parsed);
  if (decision.outcome !== terminal.outcome || decision.errorCode !== terminal.errorCode) {
    throw new HarnessError("terminal outcome does not match observed execution facts", "execution_terminal_outcome_invalid");
  }
  return { terminal, result: parsed };
}

function writeObservedPipe(
  context: ExecutionContext,
  label: string,
  pipe: RecordedCommandObservation["stdout"],
  mediaType: string,
  encoding: "utf8" | "binary",
  namespace = "blobs",
): ExecutionEvidenceReference {
  const write = writeImmutableEvidence(context.authority.receipt, {
    mode: "content-addressed",
    namespace,
    extension: encoding === "utf8" ? ".json" : ".bin",
    bytes: pipe.bytes,
    contentKind: encoding === "utf8" ? "canonical-json" : "blob",
  });
  return deepFreeze({
    path: write.path,
    byteLength: write.byteLength,
    sha256: write.sha256,
    mediaType: `${mediaType}; role=${label}`,
    encoding,
    complete: pipe.complete,
    overflow: pipe.overflow,
  });
}

function parseObservedResult(
  operation: ExecutionOperation,
  bytes: Uint8Array,
  complete: boolean,
): (TestResultReceipt | Readonly<Record<string, unknown>>) & Readonly<{ schemaVersion: string; integrityHash: string }> | null {
  if (!complete) return null;
  try {
    if (executionOperationSpec(operation).resultKind === "test-result-receipt") {
      return parseTestResultReceiptBytes(bytes);
    }
    const value = parseCanonicalSchema(Buffer.from(bytes), CHECK_RESULT_SCHEMA);
    parseTestResultReceiptValue(value.testResultReceipt);
    return deepFreeze(value) as Readonly<Record<string, unknown>> & Readonly<{ schemaVersion: string; integrityHash: string }>;
  } catch {
    return null;
  }
}

export function executionOperationSpec(operation: ExecutionOperation): typeof EXECUTION_OPERATION_SPECS[number] {
  const spec = EXECUTION_OPERATION_SPECS.find((candidate) => candidate.id === operation);
  if (spec === undefined) throw new HarnessError("execution operation is not registered", "execution_operation_invalid");
  return spec;
}

function registeredOperationForWorkerMode(
  workerMode: typeof EXECUTION_OPERATION_SPECS[number]["workerMode"],
): ExecutionOperation {
  const matches = EXECUTION_OPERATION_SPECS.filter((candidate) => candidate.workerMode === workerMode);
  if (matches.length !== 1) throw new HarnessError("execution worker mode registration is invalid", "execution_worker_mode_invalid");
  return matches[0]!.id;
}

function decideOutcome(
  operation: ExecutionOperation,
  observation: Pick<z.infer<typeof TERMINAL_SCHEMA>, "process" | "native" | "stdout" | "stderr" | "resultPipe">,
  result: ReturnType<typeof parseObservedResult>,
): Readonly<{ outcome: ExecutionOutcome; errorCode: string | null }> {
  if (observation.stdout.overflow || observation.stderr.overflow || observation.resultPipe.overflow) {
    return { outcome: "stream-overflow", errorCode: "observed_stream_too_large" };
  }
  const process = observation.process;
  if (!process.spawned) return { outcome: "setup-failed", errorCode: process.spawnErrorCode };
  if (process.signal !== null) return { outcome: "runner-crash", errorCode: `signal_${process.signal}` };
  if (!process.closeObserved || !observation.stdout.complete || !observation.stderr.complete ||
    !observation.resultPipe.complete || result === null) {
    return { outcome: "runner-error", errorCode: "incomplete_or_invalid_worker_result" };
  }
  // Native consistency binds the raw worker status, never the policy-vetoed exit.
  const completion = commandTerminalOutcome(observation.native, "execution worker", process.exitCode);
  if (completion.kind !== "pass") return { outcome: "runner-error", errorCode: "worker_native_completion_unproven" };
  const declared = result.result as Readonly<{ status: "passed" | "failed"; exitCode: 0 | 1 }>;
  if (declared.exitCode !== process.exitCode ||
    (declared.status === "passed" && process.exitCode !== 0) ||
    (declared.status === "failed" && process.exitCode !== 1)) {
    return { outcome: "runner-error", errorCode: `${operation}_exit_result_mismatch` };
  }
  return { outcome: declared.status, errorCode: declared.status === "passed" ? null : `${operation}_failed` };
}

function parseCanonicalSchema<T>(bytes: Buffer, schema: z.ZodType<T>): T {
  if (bytes.length === 0 || bytes.includes(0) || bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) {
    throw new InputError("canonical JSON framing invalid", EXECUTION_EVIDENCE_ERROR_CODE, { reason: "framing-invalid" });
  }
  let text: string;
  try {
    text = strictUtf8Text(bytes);
  } catch (error) {
    if (!hasErrorCode(error, "ERR_ENCODING_INVALID_ENCODED_DATA")) throw error;
    throw new InputError("execution evidence UTF-8 invalid", EXECUTION_EVIDENCE_ERROR_CODE, { reason: "utf8-invalid" });
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new InputError("canonical JSON BOM invalid", EXECUTION_EVIDENCE_ERROR_CODE, { reason: "bom-invalid" });
  }
  assertNoDuplicateJsonObjectKeys(text, "Execution evidence has duplicate keys", "execution_evidence_key_duplicate");
  const json = parseJsonExact(text);
  if (json === undefined) {
    throw new InputError("execution evidence JSON invalid", EXECUTION_EVIDENCE_ERROR_CODE, { reason: "json-invalid" });
  }
  const value = json.value;
  if (`${canonicalJson(value)}\n` !== text) {
    throw new InputError("execution evidence is not canonical", EXECUTION_EVIDENCE_ERROR_CODE, { reason: "noncanonical" });
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InputError("execution evidence schema invalid", EXECUTION_EVIDENCE_ERROR_CODE, {
      reason: "schema-invalid", issues: describeSchemaIssues(result.error.issues),
    });
  }
  const parsed = result.data;
  if (typeof parsed === "object" && parsed !== null && "integrityHash" in parsed) {
    const { integrityHash, ...unsigned } = parsed as Record<string, unknown>;
    if (canonicalHash(unsigned) !== integrityHash) {
      throw new InputError("execution evidence integrity invalid", EXECUTION_EVIDENCE_ERROR_CODE, { reason: "integrity-invalid" });
    }
  }
  return parsed;
}

function executionAuthorityPolicy() {
  return {
    rootPolicyHash: ROOT_POLICY_HASH,
    repositoryArtifactAdmitted: ROOT_POLICY.receipts.testExecution.repositoryArtifactAdmitted,
    canonicalLedgerAdmitted: ROOT_POLICY.receipts.testExecution.canonicalLedgerAdmitted,
    releaseReadinessEvidenceAllowed: ROOT_POLICY.receipts.testExecution.releaseReadinessEvidenceAllowed,
    findingRemovalEvidenceAllowed: ROOT_POLICY.receipts.testExecution.findingRemovalEvidenceAllowed,
  } as const;
}
