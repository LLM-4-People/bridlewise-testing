import { HarnessError, InputError } from "../../../../../src/kernel/errors.ts";
import {
  createExclusiveDurableFile,
  enumerateDurableDirectory,
  readDurableFile,
  withDurableDirectory,
  type DurableDirectoryEntry,
  type DurableFileRead,
} from "../../../../../src/filesystem/durable-filesystem.ts";
import { canonicalDomainHash, deepFreeze } from "../../../../../src/kernel/integrity.ts";
import { assertExactWriteAuthorized, type ExactWriteLease } from
  "../../../../../src/modules/effect-boundary/index.ts";
import { z } from "zod";

import {
  CONTENT_STORE_JOURNAL_PHASE_REGISTRY,
  CONTENT_STORE_JOURNAL_SCHEMA_VERSION,
  type ContentJournal,
} from "../domain/contracts.ts";
import { canonicalDocumentBytes, parseCanonicalJsonDocument } from "../domain/identities.ts";
import type { ContentRootCapability } from "./reconstruct.ts";
import {
  type ExecutionPlan,
  type ContentStorePublicErrorProjection,
  type JournalInspection,
  type JournalPhase,
  type PlannedPublication,
} from "./transaction-contracts.ts";
import {
  CONTENT_STORE_SYNTHETIC_ATTEMPT_ID_PATTERN,
  journalFileName,
} from "./transaction-plan.ts";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const JOURNAL_SCHEMA = z.strictObject({
  schemaVersion: z.literal(CONTENT_STORE_JOURNAL_SCHEMA_VERSION),
  transactionId: SHA256,
  planIdentity: SHA256,
  attemptId: z.string().regex(CONTENT_STORE_SYNTHETIC_ATTEMPT_ID_PATTERN),
  attemptAuthority: z.literal("caller-supplied-synthetic-unadmitted"),
  attemptChronologyClaim: z.literal(false),
  phase: z.string().min(1),
  registryIdentity: SHA256,
  registrySha256: SHA256,
  priorActiveIdentity: z.null(),
  writeSetIdentity: SHA256,
  journalIdentity: SHA256,
});

export function projectContentStorePublicError(error: unknown): ContentStorePublicErrorProjection {
  const admitted = error instanceof HarnessError &&
    (error.code.startsWith("content_store_") || error.code.startsWith("effect_write_"));
  if (!admitted) return deepFreeze({
    name: "HarnessError" as const,
    message: "Content store operation failed",
    code: "content_store_unclassified_error",
    retryable: false as const,
    safeDetails: {},
  });
  return deepFreeze({
    name: error.name === "InputError" || error.name === "SecurityError" ? error.name : "HarnessError",
    message: error.message,
    code: error.code,
    retryable: false as const,
    safeDetails: {},
  });
}

export function readDurableRootDirectory(stateRootPath: string): readonly DurableDirectoryEntry[] {
  return durableOperation(() => withDurableDirectory(
    { absoluteRoot: stateRootPath, relativeSegments: [], create: false },
    (directory) => enumerateDurableDirectory(directory),
  ));
}

export function readStateFile(stateRootPath: string, fileName: string): DurableFileRead {
  return durableOperation(() => withDurableDirectory(
    { absoluteRoot: stateRootPath, relativeSegments: [], create: false },
    (directory) => readDurableFile(directory, fileName),
  ));
}

export function inspectJournal(stateRootPath: string, execution: ExecutionPlan): JournalInspection {
  const prefix = `journal-${execution.base.transactionId}-`;
  const entries = readDurableRootDirectory(stateRootPath).filter((entry) => entry.name.startsWith(prefix));
  const phases = new Map<JournalPhase, ContentJournal>();
  for (const entry of entries) {
    if (entry.kind !== "file") {
      throw new InputError("Content store journal entry is unsafe", "content_store_journal_entry_unknown");
    }
    const read = readStateFile(stateRootPath, entry.name);
    if (read.disposition !== "present") {
      throw new InputError("Content store journal entry is unreadable", "content_store_journal_entry_invalid");
    }
    const journal = parseJournal(read.bytes);
    if (phases.has(journal.phase)) {
      throw new InputError("Content store journal phase is duplicated", "content_store_journal_phase_duplicate");
    }
    phases.set(journal.phase, journal);
    const phaseRegistration = phaseById(journal.phase);
    if (entry.name !== journalFileName(execution.base.transactionId, phaseRegistration.fileName)) {
      throw new InputError("Content store journal entry is unknown", "content_store_journal_entry_unknown");
    }
    const expected = execution.journals.get(journal.phase)!;
    if (!Buffer.from(canonicalDocumentBytes(journal)).equals(Buffer.from(canonicalDocumentBytes(expected)))) {
      throw new InputError("Content store journal phase conflicts", "content_store_journal_phase_conflict");
    }
  }
  let missing = false;
  let terminal: JournalPhase | null = null;
  for (const phase of CONTENT_STORE_JOURNAL_PHASE_REGISTRY) {
    if (!phases.has(phase.id)) {
      missing = true;
      continue;
    }
    if (missing) {
      throw new InputError("Content store journal phase is out of order", "content_store_journal_phase_out_of_order");
    }
    terminal = phase.id;
  }
  return Object.freeze({ phases, terminal });
}

export function assertClaimedDurability(
  stateRootPath: string,
  execution: ExecutionPlan,
  inspection: JournalInspection,
): void {
  if (inspection.terminal === "objects-published" || inspection.terminal === "active-published") {
    for (const publication of execution.base.candidateObjects) {
      assertStateFileIdentical(stateRootPath, publication, "content_store_journal_phase_conflict");
    }
  }
  if (inspection.terminal === "active-published") {
    assertStateFileIdentical(stateRootPath, execution.base.activePublication, "content_store_journal_phase_conflict");
  }
}

export function publishStateFile(
  stateRootPath: string,
  stateRoot: ContentRootCapability,
  lease: ExactWriteLease,
  publication: PlannedPublication,
): void {
  assertExactWriteAuthorized(lease, stateRoot, {
    operation: "publish-file",
    relativePath: publication.relativePath,
  });
  const existing = readStateFile(stateRootPath, publication.fileName);
  if (existing.disposition === "present") {
    if (!Buffer.from(existing.bytes).equals(Buffer.from(publication.bytes))) {
      throw new InputError("Content store exclusive publication conflicts", conflictCode(publication.kind));
    }
    return;
  }
  if (existing.disposition === "unsafe") {
    throw new InputError("Content store destination is unsafe", "content_store_state_file_unsafe");
  }
  durableOperation(() => withDurableDirectory(
    { absoluteRoot: stateRootPath, relativeSegments: [], create: true },
    (directory) => createExclusiveDurableFile(directory, publication.fileName, publication.bytes),
  ));
  assertStateFileIdentical(
    stateRootPath,
    publication,
    publication.kind === "active"
      ? "content_store_active_publication_ambiguous"
      : "content_store_state_publication_ambiguous",
  );
}

export function assertActiveIsAbsentOrIdentical(read: DurableFileRead, expected: Uint8Array): void {
  if (read.disposition === "unsafe") {
    throw new InputError("Content store active registry is unsafe", "content_store_active_registry_unsafe");
  }
  if (read.disposition === "present" && !Buffer.from(read.bytes).equals(Buffer.from(expected))) {
    throw new InputError(
      "Content store active replacement authority is absent",
      "content_store_active_replacement_authority_absent",
    );
  }
}

function parseJournal(bytes: Uint8Array): ContentJournal {
  let parsed: z.infer<typeof JOURNAL_SCHEMA>;
  try {
    parsed = JOURNAL_SCHEMA.parse(parseCanonicalJsonDocument(bytes, "Content store journal"));
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("Content store journal is invalid", "content_store_journal_entry_invalid");
  }
  const phase = phaseById(parsed.phase).id;
  const { journalIdentity, ...payload } = parsed;
  if (canonicalDomainHash("content-store.journal/v1", { ...payload, phase }) !== journalIdentity) {
    throw new InputError("Content store journal identity is invalid", "content_store_journal_identity_invalid");
  }
  return deepFreeze({ ...parsed, phase }) as ContentJournal;
}

function assertStateFileIdentical(stateRootPath: string, publication: PlannedPublication, code: string): void {
  const read = readStateFile(stateRootPath, publication.fileName);
  if (read.disposition !== "present" ||
    !Buffer.from(read.bytes).equals(Buffer.from(publication.bytes))) {
    throw new InputError("Content store durable bytes conflict", code);
  }
}

function durableOperation<Result>(operation: () => Result): Result {
  try {
    return operation();
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as HarnessError).code)
      : "unknown";
    if (code === "filesystem_runtime_not_admitted") {
      throw new InputError("Content store durable runtime is not admitted", "content_store_runtime_not_admitted");
    }
    throw new InputError("Content store durable filesystem operation failed", "content_store_durable_operation_failed");
  }
}

function phaseById(id: string): typeof CONTENT_STORE_JOURNAL_PHASE_REGISTRY[number] {
  const phase = CONTENT_STORE_JOURNAL_PHASE_REGISTRY.find((candidate) => candidate.id === id);
  if (phase === undefined) {
    throw new InputError("Content store journal phase is unknown", "content_store_journal_phase_unknown");
  }
  return phase;
}

function conflictCode(kind: PlannedPublication["kind"]): string {
  if (kind === "active") return "content_store_active_replacement_authority_absent";
  if (kind === "journal") return "content_store_journal_phase_conflict";
  return "content_store_immutable_object_conflict";
}
