/**
 * THE SEALED REALM — where `project()` runs, so its purity is a boundary and
 * not a convention (github-only §9.0, V-26).
 *
 * {@link sealedCall} runs one exported function of a declared set of modules
 * in a CHILD PROCESS (`realm-child.ts`), inside a fresh JavaScript realm that
 * holds only the language's own built-ins:
 *   - no network: nothing that could open a connection exists there (no
 *     `fetch`, no `require`, no `process`, no `node:` import — the module
 *     linker refuses every specifier outside the declared modules);
 *   - no clock and no randomness: `Date`, `Intl`, `performance`, `Math.random`,
 *     `crypto`, the timers and the locale-dependent methods throw
 *     `projection_impure: <name>` on any touch;
 *   - no code from strings (`eval`, `Function`, WebAssembly compilation);
 *   - the realm's global is its own object (never one of the host's), and
 *     only TEXT crosses: the input in, the answer out.
 * Each call is its own process, so two calls on one input are two
 * independent computations (V-26: the same digest in two processes).
 *
 * A refusal is typed: `projection_impure` (a forbidden touch, naming it),
 * `projection_import_refused` (a module outside the declared set),
 * `projection_failed` (the function threw, or answered no text).
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../../kernel/errors.ts";
import { debugLog } from "../../../shared/debug/debug-system.ts";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHILD = join(dirname(fileURLToPath(import.meta.url)), "realm-child.ts");

/** What a sealed call loads: `entry` and every module it may import (absolute paths), and the function it calls. */
export type SealedModule = Readonly<{
  entry: string;
  modules: readonly string[];
  exportName: string;
}>;

/** The projection's realm: `project.ts`'s `projectText`, and the pure modules it is allowed to load. */
export const PROJECTION_REALM: SealedModule = Object.freeze({
  entry: join(SOURCE_ROOT, "workflow/forge/projector/project.ts"),
  modules: Object.freeze([
    "workflow/forge/projector/project.ts",
    "workflow/forge/projector/model.ts",
    "workflow/markdown-links.ts",
    "kernel/product-identity.ts",
    // The one Markdown parser, at the repository's root (pure, no import).
    "../../shared/markdown.ts",
  ].map((path) => join(SOURCE_ROOT, path))),
  exportName: "projectText",
});

/** The exit statuses the child answers with (`realm-child.ts`), and the code each one is. */
export const REALM_EXIT = Object.freeze({ impure: 3, importRefused: 4, failed: 5 } as const);
const CODES: Readonly<Record<number, string>> = Object.freeze({
  [REALM_EXIT.impure]: "projection_impure",
  [REALM_EXIT.importRefused]: "projection_import_refused",
  [REALM_EXIT.failed]: "projection_failed",
});

/** `module.exportName(input)`, computed in a sealed realm in a child process; its text answer, or a typed refusal. */
export function sealedCall(module: SealedModule, input: string): string {
  const request = JSON.stringify({ entry: module.entry, modules: module.modules, exportName: module.exportName, input });
  const child = spawnSync(process.execPath, ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", CHILD], {
    input: request,
    encoding: "utf8",
    // Nothing of this process's environment reaches the computation (no preload, no locale, no zone).
    env: {},
    maxBuffer: 256 * 1024 * 1024,
  });
  if (child.error !== undefined) throw new HarnessError(`the sealed realm did not start: ${child.error.message}`, "projection_failed");
  if (child.status === 0) return child.stdout;
  const code = CODES[child.status ?? -1] ?? "projection_failed";
  const reason = child.stderr.trim().split("\n").at(-1) ?? "";
  debugLog("forge", "warn", `sealed realm refused ${module.exportName}: ${code}: ${reason}`, () => ({ entry: module.entry, status: child.status, signal: child.signal }));
  throw new HarnessError(`${code}: ${reason || `the sealed realm ended with status ${String(child.status)}${child.signal === null ? "" : ` (${child.signal})`}`}`, code);
}
