
import { runCheckWithEvidence } from "./run-tests.ts";
import { HarnessError, extractErrorMessage } from "../../src/kernel/errors.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

async function runCli(): Promise<number> {
  try {
    const execution = await runCheckWithEvidence();
    process.stdout.write(execution.stdout);
    process.stderr.write(execution.stderr);
    return execution.exitCode;
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "check_failed";
    process.stderr.write(`${canonicalJson({ error: code, message: extractErrorMessage(error) })}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runCli();
}
