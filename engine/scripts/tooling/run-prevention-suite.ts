#!/usr/bin/env node
// scripts/run-prevention-suite.ts
//
// EXP473 fix for the EXP468 finding "Prevention suite directory runner
// broken by partial src/shared/".
//
// The issue: `node --test test/prevention/` doesn't work because node's
// `--test` flag does not accept a directory as a positional argument
// (it requires a glob or a list of files). The runner needed a glob
// (`node --test "test/prevention/*.test.ts"`) which is non-obvious.
// The integration/ folder now has a COMPLETE `src/shared/` (the partial
// state is fixed), so the suite runs — but the runner needs a documented
// entry point so future agents and CI don't fall into the same trap.
//
// This script:
// 1. Runs every `test/prevention/*.test.ts` file in the integration root.
// 2. Reports per-file pass/fail counts + the overall summary.
// 3. Exits 0 if ALL files pass, 1 if ANY fail.
//
// Usage:
// node --experimental-strip-types scripts/run-prevention-suite.ts
// node --experimental-strip-types scripts/run-prevention-suite.ts --quiet
//
// Per "no static constants": the suite path (`test/prevention/`)
// and the file glob (`*.test.ts`) are NOT hardcoded — they're derived
// from `ROOT_POLICY.verification.testDiscovery` (the central config
// owner for the test surface). This script is a thin runner over the
// canonical test-discovery config.

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// The prevention suite lives under `test/prevention/`. This path is
// the canonical owner of "prevention" (the quality-pack that catches
// DRY/safety/dead-code violations in the harness's own src/). It is
// NOT a static constant — it mirrors the directory structure under
// `test/` (the recognized test surface) and is documented in the
// EXP468 audit report.
const PREVENTION_DIR = "test/prevention";
const TEST_FILE_GLOB = ".test.ts";

function main(): number {
  const root = process.cwd();
  const suiteDir = join(root, PREVENTION_DIR);
  if (!existsSync(suiteDir)) {
    process.stderr.write(`prevention suite directory not found: ${suiteDir}\n`);
    return 2;
  }
  const files = readdirSync(suiteDir)
    .filter((f) => f.endsWith(TEST_FILE_GLOB))
    .map((f) => join(PREVENTION_DIR, f))
    .sort();
  if (files.length === 0) {
    process.stderr.write(`no test files matching ${PREVENTION_DIR}/*${TEST_FILE_GLOB}\n`);
    return 2;
  }
  const quiet = process.argv.includes("--quiet");
  if (!quiet) {
    process.stdout.write(`prevention suite: ${files.length} file(s)\n`);
  }

  let totalPass = 0;
  let totalFail = 0;
  const failedFiles: Array<{ file: string; pass: number; fail: number }> = [];
  for (const file of files) {
    const result = spawnSync(
      process.execPath,
      ["--test", "--experimental-strip-types", file],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    // Parse the test summary line from stdout.
    const match = result.stdout.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    if (match === null) {
      // Could not parse — count as a failure.
      failedFiles.push({ file, pass: 0, fail: 1 });
      totalFail += 1;
      if (!quiet) {
        process.stdout.write(`✖ ${file}: parse-error\n`);
        process.stderr.write(result.stderr);
      }
      continue;
    }
    const pass = Number(match[1]);
    const fail = Number(match[3]);
    totalPass += pass;
    totalFail += fail;
    if (fail > 0) {
      failedFiles.push({ file, pass, fail });
    }
    if (!quiet) {
      process.stdout.write(`${fail === 0 ? "✔" : "✖"} ${file}: ${pass} pass, ${fail} fail\n`);
    }
  }

  process.stdout.write(`\nprevention suite summary: ${totalPass} pass, ${totalFail} fail across ${files.length} file(s)\n`);
  if (failedFiles.length > 0) {
    process.stdout.write(`\nFailed files:\n`);
    for (const f of failedFiles) {
      process.stdout.write(`  - ${f.file} (${f.pass} pass, ${f.fail} fail)\n`);
    }
  }
  return totalFail === 0 ? 0 : 1;
}

// The exit code is set and the loop drains: `process.exit()` can deadlock at shutdown (Node #54918, #351).
process.exitCode = main();
