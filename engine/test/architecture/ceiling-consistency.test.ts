import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { MCP_MAX_TOOLS, MCP_MAX_TOOL_NAME_LENGTH } from "../../src/mcp/index.ts";
import {
  MAX_BOUNDS_MEMORY_BYTES,
  MAX_BOUNDS_OUTPUT_BYTES,
  MAX_BOUNDS_TIMEOUT_MS,
} from "../../src/tools/tool-manifest.ts";

/**
 * Tool/MCP ceiling consistency (SSOT-14/15, GAP-18).
 *
 * The tool-manifest and MCP module validation ceilings must equal (and stay
 * within) the root-policy safety floor. The ceilings are now DERIVED from
 * ROOT_POLICY at module load, so literal drift is structurally impossible.
 * These tests verify (a) each exported constant is wired to the correct
 * ROOT_POLICY field (catches mis-wiring to the wrong limit), (b) the tools
 * ceilings stay within the runtime ceilings (a cross-section invariant over
 * ROOT_POLICY itself), and (c) the source derives the constants from
 * ROOT_POLICY rather than re-hardcoding independent numeric literals (a
 * provenance lock that prevents a regression back to the old duplicated
 * literals).
 *
 * The MCP constants now live in `src/mcp/core.ts` (the shared MCP module).
 * The old `src/tools/mcp-adapter.ts` facade is deleted; this test imports
 * the canonical owner directly.
 */

const MAX_MCP_TOOLS = MCP_MAX_TOOLS;
const MAX_TOOL_NAME_LENGTH = MCP_MAX_TOOL_NAME_LENGTH;

test("Ceiling consistency: tool-manifest MAX_BOUNDS_TIMEOUT_MS === ROOT_POLICY.tools.limits.maximumToolTimeoutMs", () => {
  assert.equal(MAX_BOUNDS_TIMEOUT_MS, ROOT_POLICY.tools.limits.maximumToolTimeoutMs);
});

test("Ceiling consistency: tool-manifest MAX_BOUNDS_OUTPUT_BYTES === ROOT_POLICY.tools.limits.maximumToolOutputBytes", () => {
  assert.equal(MAX_BOUNDS_OUTPUT_BYTES, ROOT_POLICY.tools.limits.maximumToolOutputBytes);
});

test("Ceiling consistency: tool-manifest MAX_BOUNDS_MEMORY_BYTES === ROOT_POLICY.tools.limits.maximumToolMemoryBytes", () => {
  assert.equal(MAX_BOUNDS_MEMORY_BYTES, ROOT_POLICY.tools.limits.maximumToolMemoryBytes);
});

test("Ceiling consistency: MCP MAX_MCP_TOOLS === ROOT_POLICY.tools.limits.maximumEnabledTools", () => {
  assert.equal(MAX_MCP_TOOLS, ROOT_POLICY.tools.limits.maximumEnabledTools);
});

test("Ceiling consistency: MCP MAX_TOOL_NAME_LENGTH === ROOT_POLICY.tools.limits.maximumToolNameCharacters", () => {
  assert.equal(MAX_TOOL_NAME_LENGTH, ROOT_POLICY.tools.limits.maximumToolNameCharacters);
});

test("Ceiling consistency: ceilings are positive and within root-policy runtime limits", () => {
  assert.ok(MAX_BOUNDS_OUTPUT_BYTES > 0);
  assert.ok(MAX_BOUNDS_MEMORY_BYTES > 0);
  assert.ok(MAX_MCP_TOOLS > 0);
  assert.ok(MAX_TOOL_NAME_LENGTH > 0);
  assert.ok(MAX_BOUNDS_OUTPUT_BYTES <= ROOT_POLICY.runtime.limits.maximumToolOutputBytes);
  assert.ok(MAX_BOUNDS_MEMORY_BYTES <= ROOT_POLICY.runtime.limits.maximumToolMemoryBytes);
});

test("Ceiling consistency: ceilings are derived from ROOT_POLICY, not re-hardcoded literals", () => {
  const toolManifestSrc = readFileSync(new URL("../../src/tools/tool-manifest.ts", import.meta.url), "utf8");
  const mcpCoreSrc = readFileSync(new URL("../../src/mcp/core.ts", import.meta.url), "utf8");
  assert.ok(
    !/\bMAX_BOUNDS_TIMEOUT_MS\s*=\s*[0-9]/u.test(toolManifestSrc),
    "MAX_BOUNDS_TIMEOUT_MS must be derived from ROOT_POLICY, not a numeric literal",
  );
  assert.ok(
    !/\bMAX_BOUNDS_OUTPUT_BYTES\s*=\s*[0-9]/u.test(toolManifestSrc),
    "MAX_BOUNDS_OUTPUT_BYTES must be derived from ROOT_POLICY, not a numeric literal",
  );
  assert.ok(
    !/\bMAX_BOUNDS_MEMORY_BYTES\s*=\s*[0-9]/u.test(toolManifestSrc),
    "MAX_BOUNDS_MEMORY_BYTES must be derived from ROOT_POLICY, not a numeric literal",
  );
  assert.ok(
    !/\bMAX_MCP_TOOLS\s*=\s*[0-9]/u.test(mcpCoreSrc),
    "MAX_MCP_TOOLS must be derived from ROOT_POLICY, not a numeric literal",
  );
  assert.ok(
    !/\bMAX_TOOL_NAME_LENGTH\s*=\s*[0-9]/u.test(mcpCoreSrc),
    "MAX_TOOL_NAME_LENGTH must be derived from ROOT_POLICY, not a numeric literal",
  );
});
