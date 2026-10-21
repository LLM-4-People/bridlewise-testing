// @vitest-environment node
/**
 * Mechanical enforcement: the Single-Party-Owner principle for CONFIG.
 *
 * ("Single-Party-Owner"): "CONFIG reading must have
 * ONE owner module. ALL code reads config through ONE accessor, never
 * `process.env` directly." Enforcement is split by codebase because the two
 * sides have different architectures:
 *
 * 1. WEB UI (`src/` + `server/`): env-var reads are centralized in
 * `server/config.ts` (`resolveServerConfig`). No other `src/` or `server/`
 * file may read `process.env` (the browser has no process; server modules
 * receive config values from the owner). This was the Round-1 fix
 * (`git-bridge.ts` stopped reading `process.env` directly); this test
 * pins it so a new module cannot silently reintroduce a scattered knob.
 *
 * 2. INTEGRATION (`engine/src/`): the config DOCUMENT
 * (`bridlewise.config.json`) is owned by `src/config.ts`
 * (`loadPinnedConfigSnapshot` — the frozen, integrity-checked accessor).
 * Env vars in the integration serve OTHER concerns (subprocess env
 * passthrough, Landlock security sentinels, the LTR wrapper IPC,
 * `resolveApiKey` provider-credential accessor), so a blanket
 * "no process.env" rule would false-positive on legitimate operational
 * patterns. Instead this test flags DIRECT config-FILE reads (parsing
 * `bridlewise.config.json` from disk) that bypass `src/config.ts` —
 * the real config-owner violation. The single documented early-boot
 * exception is `src/shared/dev-mode-env.ts` (it must read the raw config
 * BEFORE `loadPinnedConfigSnapshot` is available, because it sets the
 * env vars the pinned-snapshot loader itself depends on — a genuine
 * boot-ordering constraint, not an allowlist dodge).
 *
 * 3. WEB UI LAUNCHER SCRIPTS (`scripts/`): launcher scripts legitimately
 * read env vars (PATH, HARNESS_* credentials) to pass to the child server
 * (which reads them via `server/config.ts`). The config-owner violation
 * here is a hardcoded SECRET assigned directly to a `HARNESS_*` env var
 *. This
 * test flags a `HARNESS_*_KEY` (or `HARNESS_*_PASSWORD`) env-var field
 * assigned directly from an `"sk-..."`/string literal — the `sd.mjs`
 * regression where the API key was buried as a primary literal. Reading
 * from `process.env` first (with a documented dev fallback in a separate
 * const) is the required pattern.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";

const WEB_ROOT = process.cwd();
// The engine tree. A sibling checkout until the monorepo assembly
// (2026-07-30, `../harness-main-v1/integration`); a subdirectory of this same
// repository since. The scan's universe is unchanged — the same files, reached
// by a shorter path.
const INTEGRATION_ROOT = join(WEB_ROOT, "engine");

// All executable script extensions the web UI + integration may use. The
// scan must cover EVERY extension a future module could adopt so a new
// `.mjs`/`.cjs`/`.js` file that reads `process.env` or the config file
// cannot bypass the owner (deny-by-default — the test discovers by
// extension, not by a hardcoded file list that could rot).
const SOURCE_EXTS = [".ts", ".svelte", ".mjs", ".cjs", ".js"] as const;

// ── Helpers ──
// The shared `walk` from tests/helpers/source-scan.ts is used for every scan
// in this file (No Scattered Helpers — a local walk duplicate was removed). It
// accepts an `exts` filter so each scan narrows to the extensions it needs.

// Detects a direct `process.env` read. Also detects the destructuring bypass
// (`const { env } = process; env.FOO`) — a module that extracts `env` from
// `process` without writing the literal `process.env` token would otherwise
// bypass the owner. The destructuring pattern closes that gap so a future
// module cannot read config via `env.X` after `const { env } = process`.
const ENV_RE = /\bprocess\.env\b/;
const DESTRUCTURE_ENV_RE = /\{\s*env\s*\}\s*=\s*process\b/;
const CONFIG_BASENAME_LITERAL = /"bridlewise\.config\.json"/;
const READ_OR_PARSE = /readFileSync|JSON\.parse/;

// ── 1. Web UI: process.env only in server/config.ts ──

describe("centralized configuration — web UI env reads", () => {
  const ALLOWED_ENV_FILES = new Set(["server/kernel/config.ts"]);
  const findings: { file: string; line: number; text: string }[] = [];

  for (const root of ["src", "server"] as const) {
    for (const file of walk(join(WEB_ROOT, root), { exts: [...SOURCE_EXTS] })) {
      const rel = relative(WEB_ROOT, file);
      const lines = readFileSync(file, "utf8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (!ENV_RE.test(line) && !DESTRUCTURE_ENV_RE.test(line)) continue;
        if (ALLOWED_ENV_FILES.has(rel)) continue;
        findings.push({ file: rel, line: i + 1, text: trimmed });
      }
    }
  }

  test("process.env is read only in server/config.ts (the single config owner)", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Scattered process.env read — move the config knob into server/config.ts:\n${detail}`,
      );
    }
  });

  test("client-side src/ never reads process.env", () => {
    const clientFindings = findings.filter((f) => f.file.startsWith("src/"));
    expect(clientFindings).toEqual([]);
  });
});

// ── 2. Integration: config-FILE reads go through src/config.ts ──

describe("centralized configuration — integration config-file owner", () => {
  // The single owner of the config document is `src/config.ts`
  // (`loadPinnedConfigSnapshot`); `src/root-policy.ts` is the basename
  // authority (it declares `basename: "bridlewise.config.json"` in the
  // root policy). Both are discovered DYNAMICALLY from the integration
  // source so a rename or relocation of either owner is auto-followed —
  // no manually-maintained 2-file list that could rot. Other modules import
  // `loadPinnedConfigSnapshot` FROM the owner; they do not re-parse the file.
  // THE CROSS-REPOSITORY DEPENDENCY IS DECLARED, NOT PROBED.
  //
  // This used to read `if (existsSync(integrationSrc))`, which made the whole
  // check evaporate on a checkout without the sibling — silently, while the
  // file still reported a pass. Two other guards scanning the same tree had no
  // probe at all and went vacuous instead; that was three answers to one
  // question, and the honest one is that this suite REQUIRES the sibling
  // repository. Thirty-odd web test files import from it, twenty of which
  // already fail loudly when it is absent, so pretending the dependency is
  // optional only hides it from the eight that fail quietly.
  //
  // `walk` refuses a root it cannot read, so the declaration is now inherited
  // rather than written here: an absent sibling produces a named failure at
  // the door instead of an empty scan at each call site.
  const integrationSrc = join(INTEGRATION_ROOT, "src");
  const ALLOWED_CONFIG_FILE_OWNERS = new Set<string>();
  {
    for (const file of walk(integrationSrc, { exts: [...SOURCE_EXTS] })) {
      const rel = relative(INTEGRATION_ROOT, file);
      if (rel.endsWith(".test.ts") || rel.includes("/_experiments/") || rel.includes("_experiments/")) continue;
      const src = readFileSync(file, "utf8");
      // The loader owner: exports `loadPinnedConfigSnapshot` (the frozen,
      // integrity-checked config accessor).
      if (/export\s+(?:async\s+)?function\s+loadPinnedConfigSnapshot\b/.test(src) ||
          /export\s+\{[^}]*\bloadPinnedConfigSnapshot\b[^}]*\}/.test(src)) {
        ALLOWED_CONFIG_FILE_OWNERS.add(rel);
      }
      // The basename authority: declares the config basename in a
      // root-policy field (`basename: "bridlewise.config.json"`).
      if (/basename:\s*"bridlewise\.config\.json"/.test(src)) {
        ALLOWED_CONFIG_FILE_OWNERS.add(rel);
      }
    }
  }
  // Documented early-boot exception: dev-mode-env.ts reads the raw config to
  // detect `selfProtection.enabled` BEFORE loadPinnedConfigSnapshot is
  // available, because it sets the env vars (HARNESS_REJECT_HARDLINKS/
  // SYMLINKS) that the pinned-snapshot loader's own subprocesses depend on.
  // This is a boot-ordering constraint, not a config-owner bypass. Removing
  // it would require restructuring the bootstrap; the exception is reviewed
  // here so a NEW raw config read cannot hide behind it.
  const DOCUMENTED_EARLY_BOOT_EXCEPTION = new Set([
    "src/shared/dev-mode-env.ts",
  ]);
  const findings: { file: string; line: number; text: string }[] = [];

  {
    for (const file of walk(integrationSrc, { exts: [...SOURCE_EXTS] })) {
      const rel = relative(INTEGRATION_ROOT, file);
      // Skip tests + experiments (not production config paths).
      if (rel.endsWith(".test.ts") || rel.includes("/_experiments/") || rel.includes("_experiments/")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      let hasBasename = false;
      let hasReadOrParse = false;
      const basenameLines: number[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (CONFIG_BASENAME_LITERAL.test(line)) {
          hasBasename = true;
          basenameLines.push(i + 1);
        }
        if (READ_OR_PARSE.test(line)) hasReadOrParse = true;
      }
      // A file that references the config basename AND reads/parses a file
      // is a direct config-file reader. The owners + the documented early
      // boot exception are allowed; everything else is a bypass.
      if (hasBasename && hasReadOrParse) {
        if (ALLOWED_CONFIG_FILE_OWNERS.has(rel)) continue;
        if (DOCUMENTED_EARLY_BOOT_EXCEPTION.has(rel)) continue;
        const text = lines[basenameLines[0]! - 1]!.trim();
        findings.push({ file: rel, line: basenameLines[0]!, text });
      }
    }
  }

  test("the dynamic owner discovery found the config-loader owner (sanity: the export + basename scans are not broken)", () => {
    expect(
      ALLOWED_CONFIG_FILE_OWNERS.size,
      "must discover at least the config-loader owner (loadPinnedConfigSnapshot) + the basename authority via the integration source scan",
    ).toBeGreaterThan(0);
  });

  test("integration bridlewise.config.json is read only through src/config.ts (+ documented early-boot exception)", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Direct config-file read bypassing src/config.ts (loadPinnedConfigSnapshot). ` +
          `Route through the owner, or document a new early-boot exception here:\n${detail}`,
      );
    }
  });

  test("the documented early-boot exception set is not empty (guards against a stale allowlist)", () => {
    // If someone empties DOCUMENTED_EARLY_BOOT_EXCEPTION to "tighten" the test,
    // dev-mode-env.ts would start failing — this assertion makes the
    // exception explicit and reviewed, not a silent dodge.
    expect(DOCUMENTED_EARLY_BOOT_EXCEPTION.size).toBeGreaterThan(0);
    for (const ex of DOCUMENTED_EARLY_BOOT_EXCEPTION) {
      expect(existsSync(join(INTEGRATION_ROOT, ex))).toBe(true);
    }
  });
});

// ── 3. Web UI launcher scripts: no hardcoded HARNESS_* secrets ──

describe("centralized configuration — launcher script secrets", () => {
  // A `HARNESS_*_KEY`, `HARNESS_*_PASSWORD`, `HARNESS_*_TOKEN`, or
  // `HARNESS_*_SECRET` env-var field assigned DIRECTLY from a string literal
  // is a buried secret + a hardcoded value. The required pattern reads
  // `process.env.HARNESS_*` first (the standardized flow) with a documented
  // dev fallback in a SEPARATE const. This regex catches the direct-assignment
  // regression (`HARNESS_API_KEY: "sk-..."`) but not the indirect fallback
  // pattern (`HARNESS_API_KEY: process.env.HARNESS_API_KEY || DEV_API_KEY`).
  // Deny-by-default across every secret-shaped env-var suffix so a future
  // `HARNESS_API_TOKEN: "sk-..."` cannot hide behind a `KEY`-only regex.
  const SECRET_ASSIGN_RE = /HARNESS_[A-Z_]*(?:KEY|PASSWORD|TOKEN|SECRET)\s*[:=]\s*["'`]sk-/;
  const findings: { file: string; line: number; text: string }[] = [];

  for (const file of walk(join(WEB_ROOT, "scripts"), { exts: [...SOURCE_EXTS] })) {
    const rel = relative(WEB_ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (SECRET_ASSIGN_RE.test(line)) {
        findings.push({ file: rel, line: i + 1, text: trimmed });
      }
    }
  }

  test("no HARNESS_*_KEY/PASSWORD env var is assigned directly from an sk- secret literal in scripts/", () => {
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Hardcoded secret assigned to a HARNESS_*_KEY/PASSWORD env var. ` +
          `Read from process.env first; keep any dev fallback in a separate const:\n${detail}`,
      );
    }
  });
});

// ── 4. Launcher script port-fallback contract (no drift from DEFAULT_PORT) ──

describe("centralized configuration — launcher port-fallback contract", () => {
  // The launcher scripts (sd.mjs, dev-all.ts) and the test floor's
  // `tests/setup` preflight live before/outside the server module graph, so
  // they cannot all import `server/kernel/config.ts`. The DEV PORTS are
  // declared once in `shared/dev-ports.ts`; the server config imports them,
  // Vite imports them, and the preflight reads the server's resolved port.
  // A script that restates a fallback must match the shared DEFAULT_PORT —
  // a drift makes the health check hit the wrong port with no compile-time
  // signal. The population includes `tests/setup` so the preflight cannot
  // grow a private copy again.
  const devPortsSrc = readFileSync(join(WEB_ROOT, "shared/dev-ports.ts"), "utf8");
  const apiPortMatch = devPortsSrc.match(/export\s+const\s+DEV_API_PORT\s*=\s*(\d+)/);
  if (apiPortMatch === null) {
    throw new Error("Could not parse DEV_API_PORT from shared/dev-ports.ts");
  }
  const defaultPort = Number(apiPortMatch[1]);

  test("the server config's owned defaults ARE the shared dev-port declaration", () => {
    const configSrc = readFileSync(join(WEB_ROOT, "server/kernel/config.ts"), "utf8");
    expect(configSrc).toMatch(/export\s+const\s+DEFAULT_PORT\s*=\s*DEV_API_PORT\b/);
    expect(configSrc).toContain("DEV_CLIENT_PORT");
    expect(configSrc, "DEFAULT_PORT must not restate the literal").not.toMatch(/DEFAULT_PORT\s*=\s*\d+/);
  });

  test("Vite and the freshness preflight import the one declaration, never restate a port", () => {
    for (const rel of ["vite.config.ts", "tests/setup/dev-server-freshness.ts"] as const) {
      const src = readFileSync(join(WEB_ROOT, rel), "utf8");
      expect(src, `${rel} must import shared/dev-ports.ts`).toContain("shared/dev-ports.ts");
      expect(src, `${rel} must not restate the dev ports`).not.toMatch(/\b517[34]\b/u);
    }
  });

  // Dynamically discover every launcher script that references HARNESS_WEB_PORT
  // (a new launcher with a port fallback is auto-covered, not missed by a
  // hardcoded two-file list). Scans all SOURCE_EXTS so a future .cjs/.js
  // launcher is caught too. Each one gets its test; the test judges the
  // fallback of a script that reads the variable.
  const scriptFiles: string[] = [];
  for (const root of ["scripts", "tests/setup"] as const) {
    for (const file of walk(join(WEB_ROOT, root), { exts: [...SOURCE_EXTS] })) {
      const rel = relative(WEB_ROOT, file);
      if (/HARNESS_WEB_PORT/.test(readFileSync(file, "utf8"))) scriptFiles.push(rel);
    }
  }
  for (const script of scriptFiles) {
    const full = join(WEB_ROOT, script);
    if (!existsSync(full)) continue;
    const src = readFileSync(full, "utf8");
    // Match `process.env.HARNESS_WEB_PORT ?? <digits>` or `|| <digits>`.
    const fallbackMatch = src.match(/HARNESS_WEB_PORT\s*(?:\?\?|\|\|)\s*(\d+)/);
    // A script that READS the variable from its environment is a launcher with
    // a fallback to keep in step; one that only SETS it for a child it starts
    // (the perf profile step hands vite its isolated API's port) reads none.
    // An assignment (`process.env.HARNESS_WEB_PORT = …`) sets it; anything else reads it.
    const reads = /process\.env(?:\.HARNESS_WEB_PORT\b|\[\s*["']HARNESS_WEB_PORT["']\s*\])(?!\s*=[^=])/u.test(src);
    test(`${script} port fallback matches server/config.ts DEFAULT_PORT (${defaultPort})`, () => {
      if (!reads) {
        expect(fallbackMatch, `${script} never reads HARNESS_WEB_PORT, so a fallback there would be dead`).toBeNull();
        return;
      }
      if (fallbackMatch === null) {
        throw new Error(
          `${script} does not declare a HARNESS_WEB_PORT fallback — ` +
            `add \`process.env.HARNESS_WEB_PORT ?? ${defaultPort}\` so the ` +
            `health check hits the right port`,
        );
      }
      const fallback = Number(fallbackMatch[1]);
      expect(fallback, `${script} port fallback (${fallback}) must match DEFAULT_PORT (${defaultPort})`).toBe(defaultPort);
    });
  }
});
