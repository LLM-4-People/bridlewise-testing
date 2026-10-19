import assert from "node:assert/strict";

import type { ToolAdapterResult } from "../../src/tools/tool-adapter.ts";
import type { ToolResult } from "../../src/runtime/tool-registry.ts";
import type { TimelineEventRecord } from "../../src/timeline/timeline-types.ts";

/**
 * Shared test assertions. Single owner of the result/event shape checks
 * previously inlined (and occasionally drifted) across tool and timeline
 * suites. Each helper asserts the structural contract first, then the
 * caller-supplied expectations.
 */

export function assertToolResult(
  result: ToolResult | ToolAdapterResult,
  expected: { readonly isError: boolean; readonly contentIncludes?: string },
): void {
  assert.equal(typeof result.content, "string", "tool result content must be a string");
  assert.equal(result.isError, expected.isError, `expected isError=${expected.isError}, content: ${result.content.slice(0, 200)}`);
  if (expected.contentIncludes !== undefined) {
    assert.ok(
      result.content.includes(expected.contentIncludes),
      `expected content to include ${JSON.stringify(expected.contentIncludes)}, got: ${result.content.slice(0, 200)}`,
    );
  }
}

export function assertErrorResult(
  result: ToolResult | ToolAdapterResult,
  expected: { readonly errorCode?: string; readonly contentIncludes?: string } = {},
): void {
  assertToolResult(result, { isError: true, ...(expected.contentIncludes !== undefined ? { contentIncludes: expected.contentIncludes } : {}) });
  if (expected.errorCode !== undefined) {
    const parsed = JSON.parse(result.content) as { readonly error?: unknown };
    assert.equal(parsed.error, expected.errorCode, `expected structured error code ${expected.errorCode}`);
  }
}

export function assertTimelineEvent(
  event: TimelineEventRecord,
  expected: { readonly recordKind?: string; readonly eventType?: string; readonly outcome?: string },
): void {
  assert.equal(typeof event.eventId, "string", "timeline event must carry an eventId");
  assert.ok(event.eventId.length > 0, "timeline event eventId must be non-empty");
  assert.equal(typeof event.ledgerId, "string", "timeline event must carry a ledgerId");
  if (expected.recordKind !== undefined) assert.equal(event.recordKind, expected.recordKind);
  if (expected.eventType !== undefined) assert.equal(event.eventType, expected.eventType);
  if (expected.outcome !== undefined) assert.equal(event.outcome, expected.outcome);
}
