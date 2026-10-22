import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE ONE MAIN-NESS TEST: whether the module at `moduleUrl` (its
 * `import.meta.url`) is the program node was asked to run. Compared by real
 * path, so a symlinked or relative invocation is still the program (the
 * twelve private spellings this replaced disagreed on exactly that: a
 * `file://${argv[1]}` spelling was false for a relative path, and every
 * spelling but one for a symlink). The engine's entry-point guard
 * (`test/runtime/cli-debug.test.ts`) refuses any other spelling, so every
 * entry point is found and runs the process bootstrap first.
 *
 * A LEAF MODULE (node built-ins only), so the dependency-free CI utilities
 * (the docs-link check, the built-site link crawler, the shard toolchain),
 * which run in jobs that install no package, ask the same question as every
 * other entry point. `src/runtime/cli-debug.ts` re-exports it beside the
 * process bootstrap.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined || argv1.length === 0) return false;
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      // Not on disk (an eval, a vanished file): its own spelling is the answer.
      return path;
    }
  };
  return real(resolve(argv1)) === real(fileURLToPath(moduleUrl));
}
