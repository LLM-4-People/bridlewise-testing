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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(resolve(fileURLToPath(import.meta.url)));
const guardianDir = here; // this script lives in guardian/
const binPath = join(guardianDir, 'build', 'harness-landlock-guardian');

/**
 * THE ONE WAY TO THE NATIVE TEST-PROCESS SUPERVISOR
 * (`engine/src/process/supervised-run.ts` runs every supervised command under
 * it): its path, BUILT FIRST by the one native build owner — make's
 * incremental dependency check, once per process (memoized), writing nothing
 * when the binary is up to date. There is no other way to name the binary
 * (`engine/test/process/supervised-run.test.ts` refuses another spelling of
 * its path), so no entry point can start supervised work without it.
 *
 * #293, #132: a resolve that BUILT on demand compiled
 * `guardian/build/test-process-supervisor` into the live harness folder in
 * the middle of a test run, on a runner where `make all` had not built it.
 * The order is what prevents that, not the function. `make all` builds it,
 * as does the checkout setup's `test-supervisor` command, and both suites'
 * runners call this BEFORE they snapshot the harness folder. Inside a run,
 * every call is a make that finds the binary current.
 *
 * A build that fails THROWS, typed (`code:
 * test_process_supervisor_build_failed`, with the compiler's own words): a
 * run that cannot be supervised does not start.
 */
let ensuredSupervisor: string | undefined;

export function ensureTestProcessSupervisor(): string {
  if (ensuredSupervisor !== undefined) return ensuredSupervisor;
  const result = spawnSync('make', ['--no-print-directory', '-C', guardianDir, 'test_process_supervisor'], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw Object.assign(new Error(`The native test supervisor could not be built: ${result.stderr || String(result.error)}`), {
      code: 'test_process_supervisor_build_failed',
    });
  }
  ensuredSupervisor = join(guardianDir, 'build', 'test-process-supervisor');
  return ensuredSupervisor;
}

/**
 * THE ONE-TIME HOST FIX FOR THE TEST CONFINEMENT on a host whose AppArmor
 * restricts unprivileged user namespaces (Ubuntu 24.04's default,
 * `kernel.apparmor_restrict_unprivileged_userns=1`): a profile that admits
 * them for THIS checkout's test supervisor, at its exact canonical path, and
 * nothing else — not a global switch (the confinement: `runTestCommand` in
 * `engine/src/process/supervised-run.ts`). The grant follows the path, and the
 * path is the user's to write: it admits user namespaces for whatever the user
 * places there, which they can already create without the restriction — it
 * narrows the exemption to one path, it is not a privilege boundary. Each
 * checkout and workspace installs its own (named by a digest of the path), so
 * no glob reaches a path nobody reviewed. The commands, with the file named:
 * {@link testProcessSupervisorAppArmorInstall}.
 */
export function testProcessSupervisorAppArmor(): Readonly<{ name: string; file: string; profile: string }> {
  const binary = join(realpathSync(guardianDir), 'build', 'test-process-supervisor');
  const name = `bridlewise-test-process-supervisor-${createHash('sha256').update(binary).digest('hex').slice(0, 12)}`;
  if (/[\s"#,{}]/u.test(binary)) throw new Error(`the test supervisor's path cannot be named in an AppArmor profile as it is: ${binary}`);
  return {
    name,
    file: `/etc/apparmor.d/${name}`,
    profile: [
      `# bridlewise: admits unprivileged user namespaces for the test supervisor at exactly ${binary} (the test confinement).`,
      'abi <abi/4.0>,',
      'include <tunables/global>',
      '',
      `profile ${name} ${binary} flags=(unconfined) {`,
      '  userns,',
      '}',
      '',
    ].join('\n'),
  };
}

/** The one-time install of {@link testProcessSupervisorAppArmor}, as the commands to run (the remedy names them). */
export function testProcessSupervisorAppArmorInstall(): string {
  const { file } = testProcessSupervisorAppArmor();
  return `node engine/guardian/build.ts --apparmor-profile | sudo tee ${file} >/dev/null && sudo apparmor_parser -r ${file}`;
}

function main(): void {
  if (process.argv[2] === '--apparmor-profile') {
    process.stdout.write(testProcessSupervisorAppArmor().profile);
    return;
  }
  if (process.argv[2] === '--apparmor-install') {
    process.stdout.write(`${testProcessSupervisorAppArmorInstall()}\n`);
    return;
  }
  if (process.argv[2] === '--test-process-supervisor') {
    console.log(ensureTestProcessSupervisor());
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
