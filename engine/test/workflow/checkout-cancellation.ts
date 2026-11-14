/** One native cancellation fixture; the command signals only its isolated owning driver. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonExact } from "../../src/kernel/json-integrity.ts";
import { parseHarnessCommandResult } from "../../src/workflow/command-result.ts";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import type { CommandEvidence, CheckoutCommand } from "../../src/workflow/checkout-setup.ts";

/** Build the child that signals its isolated driver after installing its graceful stop handler. */
export function cancelledCheckoutCommand(evidenceRoot: string, driverPid: number): CheckoutCommand {
  const script = [
    "const { appendFileSync, writeFileSync, writeSync } = require('node:fs')",
    `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(join(evidenceRoot, "stopped-gracefully"))}, 'yes'); process.exit(0); })`,
    `appendFileSync(${JSON.stringify(join(evidenceRoot, "physical-attempts"))}, 'x')`,
    "writeSync(2, 'npm error code ECONNRESET')",
    `process.kill(${JSON.stringify(driverPid)}, 'SIGINT')`,
    "setInterval(() => {}, 1000)",
  ].join(";");
  return { cwd: ".", argv: [process.execPath, "-e", script], timeoutMs: 30_000 };
}

/** Run an existing production adapter around the shared real command, never signalling the test process. */
export function runCancelledCheckoutScenario(evidenceRoot: string, scenario: string): unknown {
  const owner = new URL("./checkout-cancellation.ts", import.meta.url).href;
  const resultOwner = new URL("../../src/workflow/command-result.ts", import.meta.url).href;
  const reportCommand = "checkout cancellation scenario";
  const driver = `const { default: assert } = await import("node:assert/strict");
    assert.equal(process.env.NODE_TEST_CONTEXT, undefined, "an ordinary cancellation driver must not inherit the Node test-worker protocol");
    const { writeSync } = await import("node:fs");
    const { wrapResult } = await import(${JSON.stringify(resultOwner)});
    const { cancelledCheckoutCommand } = await import(${JSON.stringify(owner)});
    const root = ${JSON.stringify(evidenceRoot)};
    const command = cancelledCheckoutCommand(root, process.pid);
    const runner = { supervisor: ${JSON.stringify(ensureTestProcessSupervisor())}, killGraceMs: 5_000, outputCharacters: 4_096,
      retries: { retries: 2, backoffMs: 1, sleep: async () => { throw new Error('a witnessed intentional stop must never schedule a retry'); } } };
    const result = await (async () => { ${scenario} })();
    writeSync(3, JSON.stringify(wrapResult(${JSON.stringify(reportCommand)}, result, { status: "pass" })));`;
  // This is an ordinary driver, not a test worker; preserve every other environment value.
  const { NODE_TEST_CONTEXT: _context, ...environment } = process.env;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", driver], { cwd: evidenceRoot, env: environment, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe", "pipe"] });
  // Production diagnostics remain in the normal test log; fd 3 owns only the structured result.
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(join(evidenceRoot, "physical-attempts"), "utf8"), "x", "there was exactly one physical command attempt");
  assert.equal(readFileSync(join(evidenceRoot, "stopped-gracefully"), "utf8"), "yes", "the command received its normal native grace");
  const resultBytes = child.output[3];
  assert.ok(typeof resultBytes === "string" && resultBytes.length > 0, "the owned result pipe must contain a report");
  const parsed = parseJsonExact(resultBytes);
  assert.ok(parsed !== undefined, "the owned result pipe must contain one complete JSON report");
  const report = parseHarnessCommandResult(parsed.value);
  assert.equal(report.command, reportCommand);
  assert.equal(report.status, "pass", "the fixture completed; its original native outcome remains in result");
  return report.result;
}

/** The native evidence survives both a direct result and an aggregate refusal. */
export function assertCancelledCheckoutFailure(failure: unknown, evidence: unknown): void {
  assert.equal(failure, "cancelled");
  assert.ok(evidence !== null && typeof evidence === "object", "the original command evidence is retained");
  const native = evidence as CommandEvidence;
  assert.equal(native.attempts, 1);
  assert.equal(native.terminal?.ending, "stopped");
  assert.equal(native.terminal?.supervision?.status, 0, "a graceful child exit never turns the witnessed stop into a pass");
  assert.equal(native.durationMs, native.terminal?.elapsedMs);
  assert.equal(native.terminal?.supervision?.noOwnedChildren, true);
}
