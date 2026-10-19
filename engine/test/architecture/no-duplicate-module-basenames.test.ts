/**
 * No Scattered Helpers — duplicate-module-basename mechanical test.
 *
 * Two source files with the SAME basename that ALSO share at least one
 * exported name are a No Scattered Helpers violation: they very likely
 * provide the same functionality from two places, so a consumer might import
 * the wrong one (or the two drift apart). The canonical example was
 * `long-task-runner.ts` existing at BOTH `src/long-task-runner.ts` AND
 * `src/tools/concurrent/long-task-runner.ts` — both exported `LongTaskRunner`,
 * `StartOptions`, `CheckResult`, etc.
 *
 * This test dynamically discovers every non-test `.ts` file under `src/`,
 * groups by basename, and for each group with more than one file, checks
 * whether any pair shares an exported name (via the same
 * `analyzeArchitectureSource` the architecture verification uses). A new
 * duplicate added anywhere in `src/` is caught automatically — there is no
 * hand-maintained list that could silently miss it.
 *
 * Barrel files (`index.ts`) are excluded: a barrel re-exports symbols from
 * its subdirectory, so two `index.ts` files in different directories
 * legitimately share exported names (the root barrel re-exports a subset of
 * a subsystem barrel). This is the universal barrel convention — a single,
 * stable exception, not a growing allowlist.
 *
 * Pre-existing same-basename + same-export pairs that are known architectural
 * debt (e.g. parallel memory stores flagged in R42) are tracked in the
 * allowlist below with a documented reason. The allowlist is deny-by-default
 * with drift detection: a new duplicate not in the allowlist FAILS, and an
 * allowlist entry whose duplicate was fixed (no longer exists) also FAILS
 * (forcing removal). The allowlist can only shrink.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { analyzeArchitectureSource } from "../../scripts/verification/architecture.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const SRC_ROOT = join(process.cwd(), "src");
const ALLOWLIST_PATH = join(process.cwd(), "test/prevention/duplicate-basenames-allowlist.json");

interface AllowlistEntry {
  basename: string;
  files: readonly string[];
  sharedExports: readonly string[];
  reason: string;
}

function loadAllowlist(): readonly AllowlistEntry[] {
  try {
    return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  } catch {
    return [];
  }
}

function listTsFiles(dir: string): string[] {
  return walk(dir, { exts: [".ts"] }).filter((file) => !file.endsWith(".test.ts"));
}

interface FileExports {
  path: string;
  exportedNames: readonly string[];
}

interface Violation {
  basename: string;
  fileA: string;
  fileB: string;
  shared: readonly string[];
}

function detectViolations(): Violation[] {
  const files = listTsFiles(SRC_ROOT);
  const byBasename = new Map<string, FileExports[]>();
  for (const file of files) {
    const basename = file.split("/").pop()!;
    if (basename === "index.ts") continue; // barrel convention
    const relPath = relative(process.cwd(), file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    const facts = analyzeArchitectureSource(relPath, source);
    const entry: FileExports = { path: relPath, exportedNames: facts.exportedNames };
    const existing = byBasename.get(basename);
    if (existing) existing.push(entry);
    else byBasename.set(basename, [entry]);
  }

  const violations: Violation[] = [];
  for (const [basename, group] of byBasename) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        const aNames = new Set(a.exportedNames);
        const shared = b.exportedNames.filter((name) => aNames.has(name));
        if (shared.length > 0) {
          violations.push({ basename, fileA: a.path, fileB: b.path, shared });
        }
      }
    }
  }
  return violations;
}

function violationKey(v: Violation): string {
  return `${v.basename}:${v.fileA}|${v.fileB}`;
}

function allowlistKey(e: AllowlistEntry): string {
  return `${e.basename}:${e.files[0]}|${e.files[1]}`;
}

test("NoDuplicateBasenames: no two src/*.ts files share a basename AND an exported name (deny-by-default, shrinking allowlist)", () => {
  const violations = detectViolations();
  const allowlist = loadAllowlist();

  // Map violations by key for lookup.
  const violationKeys = new Set(violations.map(violationKey));

  // Check allowlist entries are still real (drift detection — shrinking only).
  const staleAllowlist: string[] = [];
  for (const entry of allowlist) {
    if (!violationKeys.has(allowlistKey(entry))) {
      staleAllowlist.push(allowlistKey(entry));
    }
  }

  // Check for NEW violations not in the allowlist.
  const allowlistKeys = new Set(allowlist.map(allowlistKey));
  const newViolations = violations.filter((v) => !allowlistKeys.has(violationKey(v)));

  assert.equal(
    staleAllowlist.length,
    0,
    `Duplicate-basename allowlist has stale entr(y/ies) — a duplicate was fixed; remove the entry:\n` +
      staleAllowlist.map((k) => `  ${k}`).join("\n"),
  );

  assert.equal(
    newViolations.length,
    0,
    `No Scattered Helpers — new same-basename + same-export duplicate(s) not in the allowlist:\n` +
      newViolations.map((v) => `  ${v.basename}: ${v.fileA} and ${v.fileB} both export [${v.shared.join(", ")}]`).join("\n") +
      `\nConsolidate to a single owner, OR add to test/prevention/duplicate-basenames-allowlist.json with a reason.`,
  );
});
