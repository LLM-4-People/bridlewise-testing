/**
 * THE SHIPPED HOOKS GENERATOR: every `.githooks/<hook>` whose text is
 * canonical (`SHIPPED_HOOK_FILES`, src/kernel/verification-paths.ts), written
 * whole from its owner (`shippedHookText`, `staged-move-loss.ts`).
 *
 *   node scripts/verification/shipped-hooks.ts --check   # exit 1 when a hook is stale
 *   node scripts/verification/shipped-hooks.ts --write   # rewrite the stale hooks
 *
 * `harness check` runs it with `--check` and `harness sync` with `--write`
 * (`src/workflow/harness-commands.ts`, the shipped-hooks arm), so a hook's
 * text is a generated value with its generator, never a hand edit (UR-02,
 * PROMO34FIX-HOOK-GENERATOR). It prints ONE JSON line, the last:
 * `{ allCurrent, status, changed }`. A new hook file is made executable; an
 * existing one keeps its mode (the commit door and the installation checks
 * judge the bit). A tree without the hooks folder (a product-only tree) is
 * converged by absence.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { SHIPPED_HOOK_FILES } from "../../src/kernel/verification-paths.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { SHIPPED_HOOKS, shippedHookText } from "./staged-move-loss.ts";

export type ShippedHooksReport = Readonly<{
  allCurrent: boolean;
  status: "current" | "regenerated" | "stale" | "absent";
  changed: readonly string[];
}>;

/** The mode a NEW hook file gets: git runs only an executable hook. */
const NEW_HOOK_MODE = 0o755;

/** Judges (and with `write`, rewrites) the shipped hooks of the repository at `repositoryRoot`. */
export function syncShippedHooks(repositoryRoot: string, write: boolean): ShippedHooksReport {
  if (!existsSync(join(repositoryRoot, SHIPPED_HOOK_FILES.directory))) return Object.freeze({ allCurrent: true, status: "absent", changed: [] });
  const stale = SHIPPED_HOOKS.flatMap((hook) => {
    const path = `${SHIPPED_HOOK_FILES.directory}/${hook}`;
    const absolute = join(repositoryRoot, path);
    const text = shippedHookText(hook);
    return existsSync(absolute) && readFileSync(absolute, "utf8") === text ? [] : [{ path, absolute, text }];
  });
  if (stale.length === 0) return Object.freeze({ allCurrent: true, status: "current", changed: [] });
  const changed = Object.freeze(stale.map(({ path }) => path));
  if (!write) return Object.freeze({ allCurrent: false, status: "stale", changed });
  for (const { path, absolute, text } of stale) {
    const written = atomicWriteFile(absolute, text, { createMode: NEW_HOOK_MODE });
    if (!written.success) throw new HarnessError(`Failed to write ${path}: ${written.reason ?? "unknown error"}`, "shipped_hook_write_failed");
  }
  return Object.freeze({ allCurrent: true, status: "regenerated", changed });
}

function run(argv: readonly string[]): number {
  const { values } = parseArgs({ args: [...argv], options: { check: { type: "boolean" }, write: { type: "boolean" } } });
  if (values.check === values.write) throw new InputError("Usage: shipped-hooks [--check|--write]", "input_error");
  const repositoryRoot = dirname(fileURLToPath(new URL("../../", import.meta.url)));
  const report = syncShippedHooks(repositoryRoot, values.write === true);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.allCurrent ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = run(process.argv.slice(2));
}
