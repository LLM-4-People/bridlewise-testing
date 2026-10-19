// @vitest-environment node
/**
 * EVERY SCRIPT FILE AN NPM SCRIPT RUNS EXISTS.
 *
 * `npm run cache:evidence:sweep` named `scripts/sweep-cache-evidence.ts`
 * after the file had moved to `scripts/testing/` — the command failed with a
 * module-not-found only when somebody ran it, and nothing ran it
 * (friction-audit-1). The population is every script of both package
 * manifests; each code-file token (no glob) must name a file on disk.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const CODE_FILE = /^(?:\.\/)?[\w./-]+\.(?:ts|mts|cts|mjs|cjs|js)$/u;

describe("npm script targets", () => {
  test("every code file an npm script names exists", () => {
    const missing: string[] = [];
    let named = 0;
    for (const packageRoot of [ROOT, join(ROOT, "engine")]) {
      const scripts = (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
      for (const [name, command] of Object.entries(scripts)) {
        for (const token of command.split(/\s+/u).filter((word) => CODE_FILE.test(word) && !word.includes("*"))) {
          named += 1;
          if (!existsSync(join(packageRoot, token))) missing.push(`${packageRoot === ROOT ? "" : "engine/"}package.json ${name}: ${token}`);
        }
      }
    }
    expect(named, "the scan found no script targets").toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
