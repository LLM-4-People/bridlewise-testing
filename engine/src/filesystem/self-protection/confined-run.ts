/**
 * A NODE PROGRAM IN THE NARROWEST CONFINEMENT — the engine's launch of a
 * computation that must touch nothing but its input (the GitHub projector's
 * `project(S, L)`, src/workflow/forge/projector/). The boundary is the
 * kernel's, through the harness's one confinement owner, the guardian:
 *
 *   - FILES (Landlock): the spec is compiled by the ONE compiler
 *     (`compileSelfProtectionConfigToSpec`: the floor, W^X, the keep-out list)
 *     and then NARROWED to exactly what node needs to start — its binary, the
 *     shared libraries it has mapped (read from this process's own
 *     `/proc/self/maps`: the same binary, so the same libraries; a probe, never
 *     a per-host list) and one empty OpenSSL configuration — each READ-only
 *     (the libraries and the binary also EXECUTE). Every narrowed rule must lie
 *     inside a compiled rule with a subset of its access, or the launch is
 *     refused: narrowing can only take authority away. No path is writable;
 *     `/proc` (a clock: `/proc/uptime`), `/etc`, `/dev`, the home and the
 *     harness are unreadable;
 *   - THE NETWORK (seccomp, `network: "refused"`): no socket of any family,
 *     no io_uring;
 *   - CPU (RLIMIT_CPU, `cpu_seconds`): a program that spends its ceiling is
 *     ended by the kernel, judged by CPU work and never by wall time;
 *   - THE ENVIRONMENT: none (the environment projection of an empty allowlist):
 *     no `NODE_OPTIONS` preload, no locale, no zone reaches it;
 *   - ITS INPUT AND ITS OUTPUT: the program text arrives on stdin (with its
 *     input inside it), its one answer leaves on stdout.
 *
 * THE CLOCK IS NOT REFUSED, AND CANNOT BE: Linux serves `CLOCK_REALTIME`
 * through the vDSO (a memory read no seccomp filter sees), and a time
 * namespace offsets only the monotonic and boot clocks. A caller that needs
 * a clock-free answer runs the program twice and compares
 * (`projection.ts`): a clock read that changes the answer is caught there.
 *
 * A guardian that is missing, unstamped, or not enforcing Landlock on this
 * host is a typed refusal (`refused`, with the availability's code): never an
 * unconfined run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { HarnessError } from "../../kernel/errors.ts";
import { canonicalJson, sha256 } from "../../kernel/integrity.ts";
import { projectEnvironment } from "../../process/environment-projection.ts";
import { createOwnedTemporaryDirectory, PRIVATE_STATE_FILE_MODE, removeOwnedTemporaryDirectory } from "../private-state.ts";
import { classifyGuardianResult, compileSelfProtectionConfigToSpec, resolveGuardianBinaryPath, verifyGuardianBinaryAvailability } from "./guardian-binary.ts";
import { computeGuardianBuildStamp } from "./guardian-build-stamp.ts";
import type { KeepOutFacts } from "./keep-out.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG, parseSelfProtectionConfig } from "./self-protection-config.ts";
import { GUARDIAN_BINARY_ERROR_CODES, GUARDIAN_SPEC_SCHEMA, type GuardianBinaryAvailability, type GuardianSpec, type LandlockAccessFsFlagName } from "./self-protection-contracts.ts";

export type ConfinedNodeRequest = Readonly<{
  /** The harness (engine) root: where the guardian and its sealed sources are. */
  harnessRoot: string;
  /** The host's half of the keep-out list the compiler judges every rule against. */
  keepOut: Omit<KeepOutFacts, "harnessRoot">;
  /** The ES module program node runs, given on stdin. */
  program: string;
  /** The program's CPU-time ceiling, in seconds. */
  cpuSeconds: number;
}>;

export type ConfinedNodeResult =
  | Readonly<{ status: "ok"; stdout: string; stderr: string }>
  /** The guardian could not confine (unavailable on this host, or a spec it refused): nothing ran. */
  | Readonly<{ status: "refused"; code: string; message: string }>
  /** The program ran confined and did not succeed: its exit status, or the signal that ended it (SIGKILL/SIGXCPU: its CPU ceiling). */
  | Readonly<{ status: "failed"; exitCode: number | null; signal: string | null; stdout: string; stderr: string }>;

/** One narrowed rule: a path and the access it keeps. */
type NarrowRule = Readonly<{ path: string; access: readonly LandlockAccessFsFlagName[] }>;

/**
 * `compiled` with its allow-rules REPLACED by `rules`, each of which must lie
 * at or under a compiled rule's path and keep a subset of that rule's access
 * (narrowing only takes authority away); the temp folder grant dropped; every
 * other field (handled flags, protected subtrees, the keep-out list) kept.
 * A rule outside the compiled floor is refused typed.
 */
export function narrowGuardianSpec(compiled: GuardianSpec, rules: readonly NarrowRule[]): GuardianSpec {
  const within = (path: string, base: string): boolean => {
    const rest = relative(base, path);
    return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
  };
  for (const rule of rules) {
    const covering = compiled.allow_rules.find((candidate) => within(rule.path, candidate.path) && rule.access.every((flag) => candidate.access.includes(flag)));
    if (covering === undefined) throw new HarnessError(`confined_rule_outside_floor: ${rule.path} (${rule.access.join(", ")}) is granted by no compiled rule`, "confined_rule_outside_floor");
  }
  const { temp_dir: _tempDir, temp_dir_access: _tempDirAccess, ...rest } = compiled;
  return GUARDIAN_SPEC_SCHEMA.parse({ ...rest, allow_rules: rules.map((rule) => ({ path: rule.path, access: [...rule.access] })) }) as GuardianSpec;
}

/** The shared libraries this node process has mapped (resolved): the ones the same binary needs to start. */
function mappedLibraries(): readonly string[] {
  const paths = readFileSync("/proc/self/maps", "utf8").split("\n").map((line) => line.trim().split(/\s+/u)[5]).filter((path): path is string => path !== undefined && path.startsWith("/") && /\.so(?:\.|$)/u.test(path));
  return [...new Set(paths.map((path) => realpathSync(path)))].sort();
}

let admitted: Readonly<{ key: string; availability: GuardianBinaryAvailability }> | undefined;

/** The guardian's admission (stamp, pin, a demonstrated denial), measured once per binary content and source stamp. */
function admission(harnessRoot: string): GuardianBinaryAvailability {
  const binary = resolveGuardianBinaryPath(harnessRoot);
  let content = "absent";
  try {
    if (binary !== undefined) content = sha256(readFileSync(binary));
  } catch (error) {
    content = `unreadable:${(error as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
  let stamp: string;
  try {
    stamp = computeGuardianBuildStamp(harnessRoot);
  } catch (error) {
    // No sealed sources: admission itself answers why (a key that names the failure, never a cached yes).
    stamp = `unstamped:${error instanceof HarnessError ? error.code : "unknown"}`;
  }
  const key = `${harnessRoot}\u0000${content}\u0000${stamp}`;
  if (admitted?.key !== key) admitted = { key, availability: verifyGuardianBinaryAvailability(harnessRoot) };
  return admitted.availability;
}

/** Runs `request.program` in the narrowest confinement (see the header) and answers how it ended. */
export function runConfinedNode(request: ConfinedNodeRequest): ConfinedNodeResult {
  const availability = admission(request.harnessRoot);
  if (!availability.available) return { status: "refused", code: availability.code, message: `the guardian cannot confine on this host: ${availability.code}` };
  const scratch = createOwnedTemporaryDirectory(tmpdir(), "confined-node-");
  try {
    const openssl = join(scratch, "openssl.cnf");
    writeFileSync(openssl, "", { mode: PRIVATE_STATE_FILE_MODE });
    const compiled = compileSelfProtectionConfigToSpec(
      parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true, tempDir: scratch }),
      request.harnessRoot, scratch, process.execPath, request.keepOut,
    );
    const spec: GuardianSpec = {
      ...narrowGuardianSpec(compiled, [
        { path: realpathSync(process.execPath), access: ["EXECUTE", "READ_FILE"] },
        ...mappedLibraries().map((path) => ({ path, access: ["EXECUTE", "READ_FILE"] as const })),
        { path: openssl, access: ["READ_FILE"] },
      ]),
      network: "refused",
      cpu_seconds: request.cpuSeconds,
    };
    const specPath = join(scratch, "guardian-spec.json");
    writeFileSync(specPath, canonicalJson(GUARDIAN_SPEC_SCHEMA.parse(spec)), { mode: PRIVATE_STATE_FILE_MODE });
    const child = spawnSync(availability.binaryPath, ["apply", "--spec", specPath, "--exec", realpathSync(process.execPath), `--openssl-config=${openssl}`, "--input-type=module", "-"], {
      input: request.program,
      encoding: "utf8",
      // Nothing of this process's environment reaches the program: no preload, no locale, no zone.
      env: projectEnvironment(process.env, []),
      maxBuffer: 256 * 1024 * 1024,
    });
    if (child.error !== undefined) return { status: "refused", code: "exec_failed", message: `the guardian did not start: ${child.error.message}` };
    if (child.status === 0) return { status: "ok", stdout: child.stdout, stderr: child.stderr };
    const guardian = classifyGuardianResult(child.status ?? -1, child.stderr);
    if (guardian.kind === "pre_exec_failure") return { status: "refused", code: GUARDIAN_BINARY_ERROR_CODES[guardian.exitCode], message: guardian.message };
    return { status: "failed", exitCode: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
  } finally {
    removeOwnedTemporaryDirectory(scratch);
  }
}
