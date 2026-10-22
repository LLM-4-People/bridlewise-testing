#!/usr/bin/env -S node --experimental-strip-types
/*
 * build.ts — Node build helper for the harness-landlock-guardian binary.
 *
 * Invokes `make all` in the guardian/ directory and prints the absolute path
 * of the built binary on success (exit 0). On failure, prints a typed message
 * to stderr and exits non-zero. Author B's Node wrapper shells out to this.
 *
 * Usage:
 *   node guardian/build.ts            # node 24 strips types by default
 *   ./guardian/build.ts               # executable form (chmod +x)
 *
 * The compiler is the Makefile's ONE declaration (CC := gcc-14), not a list
 * here. The compiler is not part of the trust anchor: root-policy.ts binds the
 * binary by a reproducible build stamp over the sealed sources and declared
 * flags (build-stamp.spec), so the same sources pass on any gcc.
 *
 * Exit codes:
 *   0  success (absolute binary path on stdout)
 *   2  environment problem (no Makefile)
 *   3  make failed (including a missing or broken pinned compiler)
 *   4  binary not found after make
 *   5  expected binary path is not a regular file
 *
 * No external imports; stdlib only.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(resolve(fileURLToPath(import.meta.url)));
const guardianDir = here; // this script lives in guardian/
const binPath = join(guardianDir, 'build', 'harness-landlock-guardian');

/**
 * The native test-process supervisor (`engine/src/process/supervised-run.ts`
 * runs every test run under it), built by the existing native build owner —
 * make performs its normal incremental dependency check; no interpreter,
 * bespoke artifact cache or runtime addon — and its path returned. A build
 * that fails THROWS, typed (`code: test_process_supervisor_build_failed`, with
 * the compiler's own words): a run that cannot be supervised does not start.
 */
export function testProcessSupervisorBinary(): string {
  const binary = join(guardianDir, 'build', 'test-process-supervisor');
  const result = spawnSync('make', ['--no-print-directory', '-C', guardianDir, 'test_process_supervisor'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error(`The native test supervisor could not be built: ${result.stderr || String(result.error)}`), {
      code: 'test_process_supervisor_build_failed',
    });
  }
  return binary;
}

function main(): void {
  if (process.argv[2] === '--test-process-supervisor') {
    console.log(testProcessSupervisorBinary());
    return;
  }

  if (!existsSync(join(guardianDir, 'Makefile'))) {
    console.error(`landlock-guardian build: Makefile not found in ${guardianDir}`);
    process.exitCode = 2;
    return;
  }

  // 2. Run make all (inherit stdio so compiler errors are visible).
  const mk = spawnSync('make', ['all'], { cwd: guardianDir, stdio: 'inherit' });
  if (mk.status !== 0) {
    console.error(
      `landlock-guardian build: make failed with exit ${mk.status ?? 'null'}`,
    );
    process.exitCode = 3;
    return;
  }

  // 3. Verify the binary exists at the expected path.
  if (!existsSync(binPath)) {
    console.error(
      `landlock-guardian build: binary not found at expected path ${binPath}`,
    );
    process.exitCode = 4;
    return;
  }

  let st: import('node:fs').Stats;
  try {
    st = statSync(binPath);
  } catch (e) {
    console.error(
      `landlock-guardian build: cannot stat ${binPath}: ${(e as Error).message}`,
    );
    process.exitCode = 4;
    return;
  }
  if (!st.isFile()) {
    console.error(`landlock-guardian build: ${binPath} is not a regular file`);
    process.exitCode = 5;
    return;
  }

  // 4. Report the absolute path of the built binary on stdout.
  console.log(binPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
