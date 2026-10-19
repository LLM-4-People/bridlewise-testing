import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { shouldExcludeExperiment } from "../../src/shared/source-scan.ts";

/**
 * D3 Test #5 — No editor backup files.
 *
 * Asserts no tracked or working-tree file matches `*.bak`, `*.orig`, `*~`,
 * `*.swp`, `*.swo`, `*.rej`, `.DS_Store` in `src/`, `test/`, `scripts/`,
 * `guardian/`, `traceability/`, `docs/`. The Landlock work caught a stray
 * `package.json.bak`; this prevention test ensures no such file lingers.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "test", "scripts", "guardian", "traceability", "docs"];
const BACKUP_PATTERNS = [".bak", ".orig", "~", ".swp", ".swo", ".rej", ".DS_Store"];

function matchesBackupPattern(name: string): boolean {
  return BACKUP_PATTERNS.some((p) => name.endsWith(p) || name === p);
}

test("no-editor-backup-files: git ls-files has no tracked backup files", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const offenders = tracked.filter((f) => matchesBackupPattern(f.split("/").pop()!));
  if (offenders.length > 0) {
    assert.fail(
      `git-tracked backup files found:\n` + offenders.map((f) => `  ${f}`).join("\n"),
    );
  }
});

test("no-editor-backup-files: working tree has no untracked backup files in scan dirs", () => {
  const offenders: string[] = [];
  for (const dir of SCAN_DIRS) {
    const full = join(ROOT, dir);
    scanDirForBackupFiles(full, offenders);
  }
  if (offenders.length > 0) {
    assert.fail(
      `Working-tree backup files found:\n` + offenders.map((f) => `  ${f}`).join("\n"),
    );
  }
});

function scanDirForBackupFiles(dir: string, acc: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "build") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (shouldExcludeExperiment(relative(ROOT, full).replaceAll("\\", "/"))) continue;
      scanDirForBackupFiles(full, acc);
    } else if (entry.isFile() && matchesBackupPattern(entry.name)) {
      acc.push(full);
    }
  }
}
