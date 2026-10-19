/**
 * EXP363 — Error collector: records every harness error with full context.
 *
 * The collector is the INPUT to learning. It is append-only, deterministic,
 * and makes NO LLM calls. Each error is validated against the catalog in
 * `config.ts` so an unknown type is rejected with a typed error (never
 * silently dropped, never silently accepted).
 */

import { z } from "zod";
import { ERROR_TYPE_SCHEMA } from "./config.ts";
import { HarnessError } from "../../src/kernel/errors.ts";

/** Error record schema. The single owner of the error-record shape. */
export const ERROR_RECORD_SCHEMA = z.strictObject({
  id: z.string().min(1).max(256),
  type: ERROR_TYPE_SCHEMA,
  cause: z.string().min(1).max(256),
  turn: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  tool: z.string().min(1).max(128).optional(),
  input: z.string().max(8192),
  expected: z.string().max(8192),
  actual: z.string().max(8192),
  context: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  stackTrace: z.string().max(16384).optional(),
});
export type ErrorRecord = z.infer<typeof ERROR_RECORD_SCHEMA>;

/** Options for creating an error record (without the auto-generated fields). */
export type ErrorRecordInput = Omit<ErrorRecord, "id" | "timestamp"> & {
  id?: string;
  timestamp?: number;
};

/**
 * Append-only error collector. Records are stored in insertion order.
 * The collector is single-process (Node is single-threaded); records are
 * frozen on insert so callers cannot mutate history.
 */
export class ErrorCollector {
  private records: ErrorRecord[] = [];
  private ids = new Set<string>();
  private counter = 0;
  /** Whether to retain records across rounds or reset each round. */
  private accumulate: boolean;

  constructor(opts: { accumulateAcrossRounds?: boolean } = {}) {
    this.accumulate = opts.accumulateAcrossRounds ?? true;
  }

  /**
   * Record an error. Validates the record; rejects unknown types/causes with
   * a typed `HarnessError` (never silently drops). Deduplicates by id.
   */
  record(input: ErrorRecordInput): ErrorRecord {
    const id = input.id ?? this.nextId();
    if (this.ids.has(id)) {
      throw new HarnessError(
        `duplicate error id: ${id}`,
        "auto_learn_duplicate_id",
        false,
        { id },
      );
    }
    const record: ErrorRecord = {
      ...input,
      id,
      timestamp: input.timestamp ?? Date.now(),
    };
    const parsed = ERROR_RECORD_SCHEMA.parse(record);
    this.ids.add(id);
    this.records.push(Object.freeze(parsed));
    return parsed;
  }

  private nextId(): string {
    this.counter += 1;
    return `err-${this.counter.toString(36).padStart(6, "0")}`;
  }

  /** All records in insertion order. */
  all(): readonly ErrorRecord[] {
    return [...this.records];
  }

  /** Records of a given type. */
  byType(type: string): readonly ErrorRecord[] {
    return this.records.filter((r) => r.type === type);
  }

  /** Records of a given (type, cause). */
  byTypeAndCause(type: string, cause: string): readonly ErrorRecord[] {
    return this.records.filter((r) => r.type === type && r.cause === cause);
  }

  /** Records recorded at or after a given turn. */
  since(turn: number): readonly ErrorRecord[] {
    return this.records.filter((r) => r.turn >= turn);
  }

  /** Total record count. */
  size(): number {
    return this.records.length;
  }

  /** Distinct causes observed for a type, with counts. */
  causeCounts(type: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const r of this.records) {
      if (r.type !== type) continue;
      counts.set(r.cause, (counts.get(r.cause) ?? 0) + 1);
    }
    return counts;
  }

  /** Total count for a type. */
  typeTotal(type: string): number {
    return this.records.reduce((n, r) => (r.type === type ? n + 1 : n), 0);
  }

  /** Distinct types observed (including novel types not in the known catalog). */
  observedTypes(): string[] {
    const set = new Set<string>();
    for (const r of this.records) set.add(r.type);
    return [...set];
  }

  /** Reset the collector (used when accumulateAcrossRounds is false). */
  reset(): void {
    if (this.accumulate) return;
    this.records = [];
    this.ids.clear();
    this.counter = 0;
  }

  /** Snapshot for serialization (deterministic ordering). */
  snapshot(): readonly ErrorRecord[] {
    return [...this.records];
  }
}
