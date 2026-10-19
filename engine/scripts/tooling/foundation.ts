
import { HarnessError, InputError, extractErrorMessage } from "../../src/kernel/errors.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import {
  FOUNDATION_SLICE_MODES,
  checkFoundation,
  planFoundation,
  recoverFoundation,
  writeFoundation,
  type FoundationSliceMode,
  type FoundationSliceResult,
} from "../../verification/slices/foundation.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

const VALID_MODES: ReadonlySet<string> = new Set<string>(FOUNDATION_SLICE_MODES);

function parseMode(args: readonly string[]): FoundationSliceMode {
  if (args.length !== 1) {
    throw new InputError(
      `Foundation CLI accepts exactly one mode (${[...FOUNDATION_SLICE_MODES].join(", ")}); received ${args.length} argument(s).`,
      "foundation_cli_mode_count_invalid",
    );
  }
  const candidate = args[0]!;
  if (!VALID_MODES.has(candidate)) {
    throw new InputError(
      `Foundation CLI mode is unknown: ${candidate}`,
      "foundation_cli_mode_unknown",
    );
  }
  return candidate as FoundationSliceMode;
}

function runMode(mode: FoundationSliceMode): FoundationSliceResult {
  switch (mode) {
    case "plan":
      return planFoundation();
    case "check":
      return checkFoundation();
    case "write":
      return writeFoundation();
    case "recover":
      return recoverFoundation();
  }
}

async function runCli(): Promise<number> {
  try {
    const cliArgs = process.argv.slice(2);
    for (const arg of cliArgs) {
      if (arg.startsWith("-")) {
        throw new InputError(
          `Foundation CLI rejects all flags and options: ${arg}`,
          "foundation_cli_flag_rejected",
        );
      }
    }
    const mode = parseMode(cliArgs);
    loadPinnedConfigSnapshot();
    const result = runMode(mode);
    process.stdout.write(`${canonicalJson(result)}\n`);
    return result.disposition === "clean" ? 0 : 1;
  } catch (error) {
    const code = error instanceof HarnessError ? error.code : "foundation_cli_failed";
    process.stderr.write(`${canonicalJson({ error: code, message: extractErrorMessage(error) })}\n`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runCli();
}
