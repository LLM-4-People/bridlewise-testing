// @vitest-environment node
/**
 * Prevention test: the shared config handler is the SINGLE owner of
 * `bridlewise.config.json` access.
 *
 * Before this fix, three files duplicated config reading/writing:
 * routes/config.ts had its own readFileSync + JSON.parse + writeFileSync
 * routes/tools.ts had its own readFileSync + JSON.parse + writeFileSync
 * extensions-bridge.ts had its own readFileSync + JSON.parse
 *
 * All now route through `harness-config.ts` (readConfigRaw / writeConfigRaw /
 * getExtensions). This test mechanically enforces that no server route or
 * bridge reads or writes the config file directly — they must go through the
 * canonical handler.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";

import { modulePath } from "../helpers/module-resolver.ts";
// All executable script extensions so a future `.mjs`/`.cjs`/`.js` route
// that reads the config directly is caught (deny-by-default).
const SOURCE_EXTS = [".ts", ".svelte", ".mjs", ".cjs", ".js"] as const;
const SCAN_ROOTS = ["server/routes", "server"] as const;
const CONFIG_PATH_PATTERN = /readFileSync\s*\([^)]*harnessConfigPath|writeFileSync\s*\([^)]*harnessConfigPath|readFileSync\s*\([^)]*configPath|writeFileSync\s*\([^)]*configPath/;
const DIRECT_JSON_PARSE_CONFIG = /JSON\.parse\s*\(\s*readFileSync\s*\([^)]*(?:config|harnessConfig)/;

describe("config handler dedup (single owner of config access)", () => {
  const cwd = process.cwd();
  const offenders: { file: string; line: string; lineNumber: number }[] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of walk(join(cwd, root), { exts: [...SOURCE_EXTS] })) {
      const rel = relative(cwd, file).split(process.platform === "win32" ? "\\" : "/").join("/");
      // harness-config.ts IS the canonical owner — it's allowed to read the file.
      if (rel === modulePath("harness-config.ts")) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // Flag direct readFileSync/writeFileSync of the config path.
        if (CONFIG_PATH_PATTERN.test(line) || DIRECT_JSON_PARSE_CONFIG.test(line)) {
          offenders.push({ file: rel, line: line.trim(), lineNumber: i + 1 });
        }
      }
    }
  }

  test("no route or bridge reads/writes the config file directly (all go through harness-config.ts)", () => {
    if (offenders.length > 0) {
      const detail = offenders.map((o) => `${o.file}:${o.lineNumber} → ${o.line}`).join("\n");
      throw new Error(
        `Direct config file access found — route through harness-config.ts instead:\n${detail}`,
      );
    }
  });

  test("harness-config.ts exports readConfigRaw and writeConfigRaw (the canonical read/write entry points)", async () => {
    const mod = await import("../../server/kernel/harness-config.ts");
    expect(typeof mod.readConfigRaw).toBe("function");
    expect(typeof mod.writeConfigRaw).toBe("function");
  });
});
