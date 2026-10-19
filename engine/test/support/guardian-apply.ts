/**
 * Run the real guardian with a compiled spec, for the self-protection suites:
 * write the spec to an isolated temp file, spawn `apply --spec <tmpspec>
 * --exec <payload> [args...]`, stream stdio, classify the typed result
 * (`classifyGuardianResult`), clean up, and honour an `AbortSignal`.
 *
 * TEST SUPPORT, not product code: the harness applies specs only through the
 * web server's per-spawn owner (`server/safety/landlock-runner.ts`); the
 * engine CLI's own guardian re-exec — the one production caller this used to
 * have — is gone (user decision C8).
 */
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { deepFreeze, canonicalJson } from "../../src/kernel/integrity.ts";
import { PRIVATE_STATE_FILE_MODE } from "../../src/filesystem/private-state.ts";
import { classifyGuardianResult, resolveGuardianBinaryPath } from "../../src/filesystem/self-protection/guardian-binary.ts";
import type { GuardianBinaryResult, GuardianSpec } from "../../src/filesystem/self-protection/self-protection-contracts.ts";
import { createTempDir } from "./temp-dir.ts";

export function applySelfProtection(
  spec: GuardianSpec,
  payloadExecutable: string,
  payloadArgs: readonly string[],
  options: Readonly<{ harnessRoot?: string; signal?: AbortSignal }> = {},
): Promise<GuardianBinaryResult> {
  const binaryPath = options.harnessRoot !== undefined ? resolveGuardianBinaryPath(options.harnessRoot) : undefined;
  if (binaryPath === undefined) {
    return Promise.resolve(deepFreeze<GuardianBinaryResult>({ kind: "pre_exec_failure", exitCode: 64, message: "guardian binary not found" }));
  }
  const tempDir = createTempDir("harness-guardian-apply-");
  const specPath = join(tempDir, "guardian-spec.json");
  return new Promise<GuardianBinaryResult>((resolve, reject) => {
    writeFileSync(specPath, canonicalJson(spec), { mode: PRIVATE_STATE_FILE_MODE });
    const child = spawn(binaryPath, ["apply", "--spec", specPath, "--exec", payloadExecutable, ...payloadArgs], {
      stdio: ["inherit", "inherit", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    let stderrBuffer = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      rmSync(tempDir, { recursive: true, force: true });
      if (options.signal?.aborted === true) reject(error);
      else resolve(deepFreeze<GuardianBinaryResult>({ kind: "pre_exec_failure", exitCode: 9, message: error.message }));
    });
    child.on("close", (exitCode) => {
      rmSync(tempDir, { recursive: true, force: true });
      resolve(classifyGuardianResult(exitCode ?? -1, stderrBuffer));
    });
  });
}
