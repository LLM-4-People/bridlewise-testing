import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import { InputError } from "../../kernel/errors.ts";
import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";

/**
 * THE GUARDIAN'S REPRODUCIBLE BUILD STAMP — one definition, two consumers.
 *
 * The guardian binary used to be bound by the sha256 of its BYTES. That was
 * not reproducible: the same sources compiled by the local gcc (14.2.0-4ubuntu2)
 * and by the CI runner's gcc (14.2.0-19) produced different bytes, so every CI
 * run refused confinement with `binary_hash_mismatch`. A trust anchor that
 * changes with codegen cannot be a trust anchor.
 *
 * The stamp is a digest of the SEALED INPUTS instead: the source files and the
 * declared compile flags, both owned by `guardian/build-stamp.spec`. The
 * Makefile embeds it (`-DGUARDIAN_BUILD_STAMP=…`); this module recomputes it
 * from the harness's own source tree. Any compiler then produces a binary
 * carrying the same stamp for the same inputs.
 *
 * The canonical payload — exactly what both sides hash — is:
 *
 *     <format>
 *     cflags <declared flags>
 *     source <sha256 of the file> <declared source path>
 *     …
 *
 * with one LF after every line, including the last. The Makefile's `BUILD_STAMP`
 * recipe and {@link computeGuardianBuildStamp} must agree byte for byte; the
 * focused test builds the guardian through the Makefile and compares the
 * binary's `--stamp` output with this function's answer.
 *
 * WHAT THIS DOES NOT PROVE, stated because a safety claim wider than the
 * measurement is the defect this floor exists to refuse: a binary that forges
 * its `--stamp` output is indistinguishable from an honest build without a
 * byte-level digest, and a byte-level digest is exactly what is not
 * reproducible here. The stamp proves "these sources and flags produced the
 * binary that is running" for an honest build; it is not a signature. The
 * source tree and the pin are the anchor, and both are checked below the
 * runtime door.
 *
 * A MATCHING STAMP IS NOT ADMISSION BY ITSELF. `verifyGuardianBinaryAvailability`
 * also requires the binary to run AND to deny a read inside a protected probe
 * folder while the same reader succeeds on an unprotected control file. That
 * refuses a no-op or pass-through binary that prints the expected pin. It does
 * not distinguish a forger that both prints the pin and implements the denial:
 * without an artifact outside the tree (a signature, or a trusted byte digest)
 * that binary is indistinguishable from an honest build. The claim supported
 * here is therefore narrow and exact: for an honest build, these sources and
 * flags produced the binary that is running.
 */

/** The only keys `guardian/build-stamp.spec` may declare. */
const STAMP_SPEC_KEYS = new Set(["STAMP_FORMAT", "STAMP_CFLAGS", "STAMP_SOURCES"]);

/** One resolved, validated declaration from `guardian/build-stamp.spec`. */
export type GuardianBuildStampSpec = Readonly<{
  format: string;
  cflags: string;
  sources: readonly string[];
}>;

/** What a binary's `--stamp` mode reported. */
export type GuardianBuildStampProbe =
  | Readonly<{ kind: "stamp"; stamp: string }>
  /** The binary did not exit 0 (a binary built without the Makefile exits 64). */
  | Readonly<{ kind: "absent" }>
  /** The binary exited 0 but its output is not one 64-hex stamp. */
  | Readonly<{ kind: "malformed" }>;

/** A source path the stamp may seal: repository-relative, normalized, no escape. */
function assertSealedSourcePath(source: string, specPath: string): void {
  const escaped = source.length === 0
    || isAbsolute(source)
    || source.includes("\\")
    || source.includes("\0")
    || normalize(source) !== source
    || source === "."
    || source === ".."
    || source.startsWith("../");
  if (escaped) {
    throw new InputError(
      `${specPath} names a sealed source that is not a normalized harness-relative path: ${JSON.stringify(source)}`,
      "guardian_build_stamp_inputs_invalid",
    );
  }
}

/**
 * Read and validate the sealed-inputs declaration. Throws `InputError` with
 * `guardian_build_stamp_inputs_invalid` / `guardian_build_stamp_inputs_missing`
 * — callers that must never throw (the availability probe) catch it.
 */
export function readGuardianBuildStampSpec(harnessRoot: string): GuardianBuildStampSpec {
  if (!isAbsolute(harnessRoot)) {
    throw new InputError(
      `the guardian build stamp needs an absolute harness root, got ${JSON.stringify(harnessRoot)}`,
      "guardian_build_stamp_inputs_invalid",
    );
  }
  const relativeSpecPath = ROOT_POLICY.selfProtection.buildStampSpecPath;
  const specPath = join(harnessRoot, relativeSpecPath);
  let text: string;
  try {
    text = readFileSync(specPath, "utf8");
  } catch (error) {
    throw new InputError(
      `the guardian's sealed-inputs declaration is unreadable at ${specPath}: ${error instanceof Error ? error.message : String(error)}. `
        + "A binary cannot be admitted without the inputs its build stamp claims to seal.",
      "guardian_build_stamp_inputs_missing",
    );
  }
  const values = new Map<string, string>();
  for (const [index, line] of text.split("\n").entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*:?=\s*(.*)$/u.exec(trimmed);
    if (match === null) {
      throw new InputError(
        `${relativeSpecPath}:${String(index + 1)} is not a KEY := value declaration`,
        "guardian_build_stamp_inputs_invalid",
      );
    }
    const key = match[1]!;
    if (!STAMP_SPEC_KEYS.has(key)) {
      throw new InputError(
        `${relativeSpecPath}:${String(index + 1)} declares unknown sealed-input key ${key}`,
        "guardian_build_stamp_inputs_invalid",
      );
    }
    if (values.has(key)) {
      throw new InputError(
        `${relativeSpecPath}:${String(index + 1)} declares ${key} twice; the stamp has one owner per input`,
        "guardian_build_stamp_inputs_invalid",
      );
    }
    values.set(key, match[2]!.trim());
  }
  const format = values.get("STAMP_FORMAT") ?? "";
  const cflags = values.get("STAMP_CFLAGS") ?? "";
  const sourceList = values.get("STAMP_SOURCES") ?? "";
  if (!/^bridlewise-guardian-build-stamp\/v[1-9][0-9]*$/u.test(format)) {
    throw new InputError(
      `${relativeSpecPath} declares no valid STAMP_FORMAT (got ${JSON.stringify(format)})`,
      "guardian_build_stamp_inputs_invalid",
    );
  }
  if (cflags.length === 0) {
    throw new InputError(`${relativeSpecPath} declares no STAMP_CFLAGS`, "guardian_build_stamp_inputs_invalid");
  }
  const sources = sourceList.split(/\s+/u).filter((source) => source.length > 0);
  if (sources.length === 0) {
    throw new InputError(`${relativeSpecPath} declares no STAMP_SOURCES`, "guardian_build_stamp_inputs_invalid");
  }
  for (const source of sources) assertSealedSourcePath(source, relativeSpecPath);
  return deepFreeze({ format, cflags, sources: [...sources] });
}

/** The exact bytes both the Makefile and this module hash, as UTF-8 text. */
export function guardianBuildStampPayload(
  spec: GuardianBuildStampSpec,
  sourceDigests: readonly string[],
): string {
  if (sourceDigests.length !== spec.sources.length) {
    throw new InputError(
      `the guardian build stamp has ${String(sourceDigests.length)} source digests for ${String(spec.sources.length)} sealed sources`,
      "guardian_build_stamp_inputs_invalid",
    );
  }
  const lines = [
    spec.format,
    `cflags ${spec.cflags}`,
    ...spec.sources.map((source, index) => `source ${sourceDigests[index]!} ${source}`),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Recompute the stamp from `harnessRoot`'s sealed source tree. `harnessRoot` is
 * the harness installation that holds `guardian/build-stamp.spec` and the
 * sources beside the built binary — the same root `resolveGuardianBinaryPath`
 * resolves the binary against. Source paths in the spec are relative to the
 * spec's own folder (the guardian directory), exactly as the Makefile's
 * `include` reads them.
 */
export function computeGuardianBuildStamp(harnessRoot: string): string {
  const spec = readGuardianBuildStampSpec(harnessRoot);
  const sourceDirectory = dirname(join(harnessRoot, ROOT_POLICY.selfProtection.buildStampSpecPath));
  const digests: string[] = [];
  for (const source of spec.sources) {
    const sourcePath = join(sourceDirectory, source);
    let stat;
    try {
      stat = lstatSync(sourcePath);
    } catch (error) {
      throw new InputError(
        `the guardian build stamp cannot read its sealed source ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
        "guardian_build_stamp_inputs_missing",
      );
    }
    if (!stat.isFile()) {
      throw new InputError(
        `the guardian build stamp's sealed source ${sourcePath} is not a regular file`,
        "guardian_build_stamp_inputs_invalid",
      );
    }
    digests.push(sha256(readFileSync(sourcePath)));
  }
  return sha256(guardianBuildStampPayload(spec, digests));
}

/** One 64-hex stamp from `--stamp`'s stdout, or undefined for anything else. */
export function parseGuardianBuildStampOutput(stdout: string): string | undefined {
  return /^([0-9a-f]{64})\n?$/u.exec(stdout)?.[1];
}
