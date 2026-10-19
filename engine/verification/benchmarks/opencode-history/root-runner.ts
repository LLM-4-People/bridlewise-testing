import { readSync, writeSync } from "node:fs";

import {
  assertMeasuredRootIdentity,
  assertSterileProcessSurface,
  IsolationPlanError,
  prepareIsolationPlanFromDeclarations,
  type IsolationCapabilityDeclarations,
} from "./isolation-plan.ts";
import {
  type ContentFreeFailureReceipt,
  type ContentFreeVerificationReceipt,
  parseScopeGuardRequestJson,
  ScopeGuardError,
  toContentFreeFailureReceipt,
  SCOPE_GUARD_LIMITS,
  verifySyntheticExactScope,
} from "./scope-guard.ts";

export type RootBoundaryFailureCode =
  | ContentFreeFailureReceipt["errorCode"]
  | IsolationPlanError["code"];

export interface ContentFreeRootBoundaryFailureReceipt {
  readonly errorCode: RootBoundaryFailureCode;
  readonly syntheticQualificationOnly: true;
  readonly realHistoryReady: false;
  readonly sec001Open: true;
}

export type RootBoundaryReceipt =
  | ContentFreeVerificationReceipt
  | ContentFreeRootBoundaryFailureReceipt;

/**
 * Dedicated root-runner boundary. It is intentionally not imported by an agent
 * runtime or composition root. A privileged supervisor must preopen both FDs,
 * construct the namespace/identity controls described by isolation-plan.ts,
 * then invoke this module with an empty argv and empty environment.
 *
 * This synthetic qualification entrypoint does not authorize real-history use.
 */
export async function runSyntheticRootBoundary(input: {
  readonly controlFd: number;
  readonly receiptFd: number;
  readonly declarations: IsolationCapabilityDeclarations;
}): Promise<RootBoundaryReceipt> {
  let receipt: RootBoundaryReceipt;
  try {
    assertSterileProcessSurface({
      controlFd: input.controlFd,
      receiptFd: input.receiptFd,
      argv: process.argv.slice(2),
      environment: process.env,
    });
    prepareIsolationPlanFromDeclarations(input.declarations);
    assertMeasuredRootIdentity(input.declarations, process.getuid?.());
    const requestBytes = readBoundedFd(input.controlFd, SCOPE_GUARD_LIMITS.maximumRequestBytes);
    const request = parseScopeGuardRequestJson(requestBytes.toString("utf8"));
    receipt = await verifySyntheticExactScope(request);
  } catch (error) {
    receipt = toContentFreeRootBoundaryFailureReceipt(error);
  }
  try {
    writeAll(input.receiptFd, Buffer.from(JSON.stringify(receipt), "utf8"));
  } catch {
    return toContentFreeRootBoundaryFailureReceipt(undefined);
  }
  return receipt;
}

export function toContentFreeRootBoundaryFailureReceipt(
  error: unknown,
): ContentFreeRootBoundaryFailureReceipt {
  if (error instanceof IsolationPlanError) {
    return Object.freeze({
      errorCode: error.code,
      syntheticQualificationOnly: true,
      realHistoryReady: false,
      sec001Open: true,
    });
  }
  return toContentFreeFailureReceipt(error);
}

function readBoundedFd(fd: number, maximumBytes: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = Buffer.alloc(64 * 1024);
    const read = readSync(fd, chunk, 0, chunk.length, null);
    if (read === 0) break;
    total += read;
    if (total > maximumBytes) throw new ScopeGuardError("scope_invalid_manifest");
    chunks.push(chunk.subarray(0, read));
  }
  return Buffer.concat(chunks, total);
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new ScopeGuardError("scope_internal_failure");
    offset += written;
  }
}
