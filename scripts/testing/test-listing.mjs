/**
 * THE TEST LISTING'S ENTRY (`npm run test:list`, `npm run test:verify-shards`):
 * the shard manifest's `list` and `verify` commands
 * (scripts/test-shard-manifest.mjs, a dependency-free module the merge job
 * runs with no package installed) with the listing's runner: vitest through
 * the one test-execution door, confined.
 */
import { resolve } from "node:path";

import { ensureTestProcessSupervisor } from "../../engine/guardian/build.ts";
import { runTestCommand, vitestCommand } from "../../engine/src/process/supervised-run.ts";
import { readTestExecutionConfig } from "../../engine/src/workflow/test-result-collector.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { parseArgs, runListingCommand } from "../test-shard-manifest.mjs";

/**
 * `vitest list --filesOnly --json` in `root`, THROUGH THE ONE TEST-EXECUTION
 * DOOR (engine/src/process/supervised-run.ts `runTestCommand`): vitest loads
 * the checkout's config and runs only confined, the checkout read-only to it.
 * Answers in the shape `listTestFiles` reads (status, stdout, stderr).
 */
export async function listThroughTheDoor(repositoryRoot) {
  const { engineSuiteWatchdog } = readTestExecutionConfig(resolve(repositoryRoot, "engine"));
  const [command, args] = vitestCommand(repositoryRoot, ["list", "--filesOnly", "--json"]);
  const stdout = [];
  const stderr = [];
  const run = await runTestCommand({
    supervisor: ensureTestProcessSupervisor(), checkout: repositoryRoot, command, args, cwd: repositoryRoot,
    hardCeilingMs: engineSuiteWatchdog.hardCeilingMs, killGraceMs: engineSuiteWatchdog.killGraceMs,
    onStdout: (chunk) => stdout.push(chunk), onStderr: (chunk) => stderr.push(chunk),
  });
  return {
    status: run.ending === "exited" ? run.exitCode : 1,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: `${Buffer.concat(stderr).toString("utf8")}${run.ending === "exited" ? "" : `vitest list ended by ${run.ending}\n`}`,
  };
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command !== "list" && options.command !== "verify") throw new Error("the test listing takes: list [--out <file>] | verify --manifest <file> --live <file>");
    await runListingCommand(options, listThroughTheDoor);
  } catch (error) {
    process.stderr.write(`shard manifest refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
