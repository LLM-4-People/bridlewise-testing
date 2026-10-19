/**
 * Provider-neutral storage contract draft. It intentionally exposes no SQL,
 * database handle, extension loader, ATTACH, filesystem path, or adapter type.
 */

export type Int64 = bigint & { readonly __int64: unique symbol };
export type Sha256 = string & { readonly __sha256: unique symbol };
export type EventId = string & { readonly __eventId: unique symbol };
export type LedgerId = string & { readonly __ledgerId: unique symbol };
export type TraceId = string & { readonly __traceId: unique symbol };
export type SpanId = string & { readonly __spanId: unique symbol };
export type CorrelationId = string & { readonly __correlationId: unique symbol };
export type PayloadReference = string & { readonly __payloadReference: unique symbol };

export type OrderedHeader = readonly [name: string, value: string];

export interface UsageMetadata {
  readonly inputTokens?: Int64;
  readonly outputTokens?: Int64;
  readonly cachedInputTokens?: Int64;
  readonly reasoningTokens?: Int64;
  readonly totalTokens?: Int64;
  readonly timeToFirstTokenUs?: Int64;
  readonly durationUs?: Int64;
  readonly tokensPerSecondMicros?: Int64;
}

export interface ModelMetadata {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly requestId?: string;
  readonly responseId?: string;
  readonly endpointClass?: string;
  readonly usage?: UsageMetadata;
}

export interface EventEnvelope {
  readonly ledgerId: LedgerId;
  readonly eventId: EventId;
  readonly eventType: string;
  readonly eventSchemaVersion: number;
  readonly occurredAtUs: Int64;
  readonly recordedAtUs: Int64;
  readonly monotonicNs: Int64;
  readonly traceId: TraceId;
  readonly spanId: SpanId;
  readonly parentSpanId?: SpanId;
  readonly correlationId: CorrelationId;
  readonly causationEventId?: EventId;
  readonly subject: Readonly<{ kind: string; id: string }>;
  readonly actor: Readonly<{ kind: string; id: string }>;
  /** Opaque address into the separately controlled encrypted payload vault. */
  readonly rawPayloadRef: PayloadReference;
  readonly rawContentSha256: Sha256;
  readonly redactedContentSha256: Sha256;
  readonly model?: ModelMetadata;
  readonly flags: number;
}

export interface RedactedEventDocuments {
  /** Canonical, schema-validated JSON; never raw provider/user bytes. */
  readonly query: Readonly<Record<string, unknown>>;
  /** Array semantics preserve duplicates, original ordering, and case. */
  readonly orderedHeaders?: readonly OrderedHeader[];
}

export interface GraphEdge {
  readonly edgeId: string;
  readonly sourceEventId: EventId;
  readonly relationType: string;
  readonly target: Readonly<{
    kind: string;
    id: string;
    eventId?: EventId;
  }>;
  readonly ordinal: number;
  readonly evidenceEventId: EventId;
}

export interface AppendRequest {
  readonly event: EventEnvelope;
  readonly documents: RedactedEventDocuments;
  readonly edges: readonly GraphEdge[];
  /** Compare-and-append guard; null means the ledger must be empty. */
  readonly expectedHeadMac: Sha256 | null;
}

export interface AppendReceipt {
  readonly eventId: EventId;
  readonly ledgerId: LedgerId;
  readonly sequence: Int64;
  readonly chainMac: Sha256;
  readonly committedAtUs: Int64;
  readonly durability: 'committed-local';
}

export interface TimelineQuery {
  readonly after?: Readonly<{ recordedAtUs: Int64; ledgerId: LedgerId; sequence: Int64 }>;
  readonly before?: Readonly<{ recordedAtUs: Int64; ledgerId: LedgerId; sequence: Int64 }>;
  readonly eventTypes?: readonly string[];
  readonly traceId?: TraceId;
  readonly correlationId?: CorrelationId;
  readonly subject?: Readonly<{ kind: string; id: string }>;
  readonly actor?: Readonly<{ kind: string; id: string }>;
  readonly limit: number;
}

export interface TimelineRecord {
  readonly event: EventEnvelope;
  readonly sequence: Int64;
  readonly chainMac: Sha256;
  readonly documents: RedactedEventDocuments;
}

export interface VerificationFinding {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ledgerId?: LedgerId;
  readonly sequence?: Int64;
  readonly eventId?: EventId;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly checkedEvents: Int64;
  readonly checkedEdges: Int64;
  readonly foreignKeyErrors: Int64;
  readonly integrity: 'ok' | 'failed';
  readonly findings: readonly VerificationFinding[];
}

export interface ProjectionRebuildReceipt {
  readonly projection: string;
  readonly through: Readonly<Record<LedgerId, Int64>>;
  readonly sourceHeadMacs: Readonly<Record<LedgerId, Sha256>>;
  readonly rebuiltAtUs: Int64;
}

export interface BackupReceipt {
  readonly backupId: string;
  readonly logicalSha256: Sha256;
  readonly encryptedArtifactRef: PayloadReference;
  readonly sourceHeads: Readonly<Record<LedgerId, Sha256>>;
  readonly createdAtUs: Int64;
}

export interface StorageCapabilities {
  readonly strictTables: true;
  readonly signedInt64: true;
  readonly wal: true;
  readonly defensiveMode: boolean;
  readonly authorizer: boolean;
  readonly runtimeLimits: boolean;
  readonly onlineBackup: boolean;
  readonly powerLossQualified: boolean;
}

export interface StorageHealth {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly sqliteVersion: string;
  readonly schemaVersion: number;
  readonly capabilities: StorageCapabilities;
  readonly ready: boolean;
  readonly blockers: readonly string[];
}

export interface EventLedgerStoragePort {
  initialize(): Promise<StorageHealth>;
  append(request: AppendRequest): Promise<AppendReceipt>;
  readTimeline(query: TimelineQuery): AsyncIterable<TimelineRecord>;
  readEdges(eventId: EventId): Promise<readonly GraphEdge[]>;
  readAttemptHistory(taskId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  readMemoryLineage(memoryId: string): Promise<readonly Readonly<Record<string, unknown>>[]>;
  verify(scope?: Readonly<{ ledgerId?: LedgerId; fullIntegrity?: boolean }>): Promise<VerificationReport>;
  rebuildProjection(name: string): Promise<ProjectionRebuildReceipt>;
  checkpoint(mode: 'passive' | 'restart' | 'truncate'): Promise<Readonly<Record<string, Int64>>>;
  createBackup(): Promise<BackupReceipt>;
  close(): Promise<void>;
}

export interface EncryptedPayloadVaultPort {
  put(input: Readonly<{
    plaintext: Uint8Array;
    contentSha256: Sha256;
    purpose: string;
  }>): Promise<Readonly<{ reference: PayloadReference; ciphertextSha256: Sha256 }>>;
  get(reference: PayloadReference, expectedContentSha256: Sha256): Promise<Uint8Array>;
}

export interface StorageFactoryConfig {
  readonly databasePath: string;
  readonly privateDirectoryMode: 0o700;
  readonly privateFileMode: 0o600;
  readonly busyTimeoutMs: number;
  readonly synchronous: 'FULL' | 'EXTRA';
  readonly walAutoCheckpointPages: number;
  readonly maximumDatabaseBytes: Int64;
  readonly maximumQueryRows: number;
  readonly migrationPolicy: 'verify-and-apply-forward-only';
}

export type EventLedgerStorageFactory = (
  config: Readonly<StorageFactoryConfig>,
  payloadVault: EncryptedPayloadVaultPort,
) => Promise<EventLedgerStoragePort>;
