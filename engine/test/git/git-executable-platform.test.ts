import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { resolveGitExecutable } from "../../src/git/git-adapter.ts";

/**
 * INVARIANT #75: resolveGitExecutable must use `where` on win32 and `which`
 * otherwise, with Windows-specific fallback paths tried on win32. The
 * platform check is read at CALL time (not module load), so mocking
 * process.platform directly affects the resolution path.
 *
 * On a Linux test machine, mocking platform to "win32" makes the function
 * try `where git` (which does not exist on Linux → fails) and Windows fallback
 * paths (C:\\Program Files\\Git\\... → do not exist on Linux), so it throws
 * InputError("Git executable not found"). This proves the Windows code path
 * was taken — `which git` would have succeeded on Linux.
 */

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(value: string): void {
  Object.defineProperty(process, "platform", { value, configurable: true, writable: true });
}

function restorePlatform(): void {
  setPlatform(ORIGINAL_PLATFORM);
}

test("GitExecutable: source uses where on win32 and which otherwise", () => {
  // Read the source at test time and verify the platform-conditional lookup.
  const source = readFileSync(join(process.cwd(), "src", "git", "git-adapter.ts"), "utf8");
  assert.ok(
    /const\s+isWindows\s*=\s*process\.platform\s*===\s*"win32"/.test(source),
    "resolveGitExecutable must check process.platform === 'win32'",
  );
  assert.ok(
    /const\s+lookup\s*=\s*isWindows\s*\?\s*"where"\s*:\s*"which"/.test(source),
    "resolveGitExecutable must use 'where' on Windows and 'which' otherwise",
  );
});

test("GitExecutable: source defines Windows-specific fallback paths", () => {
  const source = readFileSync(join(process.cwd(), "src", "git", "git-adapter.ts"), "utf8");
  assert.ok(
    source.includes("C:\\\\Program Files\\\\Git\\\\bin\\\\git.exe") ||
    source.includes("C:\\Program Files\\Git\\bin\\git.exe"),
    "resolveGitExecutable must try Windows fallback paths (C:\\Program Files\\Git\\...)",
  );
  assert.ok(
    /isWindows\s*\?/.test(source),
    "fallback paths must be gated on isWindows",
  );
});

test("GitExecutable: win32 platform tries 'where' (not 'which') and throws when not found", () => {
  try {
    setPlatform("win32");
    // On Linux, `where` does not exist (spawnSync fails) and the Windows
    // fallback paths don't exist on the filesystem. So resolveGitExecutable
    // must throw InputError("Git executable not found"). If it had used
    // `which`, it would have succeeded (git is installed on the test machine).
    assert.throws(
      () => resolveGitExecutable(),
      (error: unknown) => {
        if (!(error instanceof Error)) return false;
        return /not found/i.test(error.message);
      },
      "on win32 (mocked), resolveGitExecutable must throw because 'where' and Windows paths don't exist on Linux",
    );
  } finally {
    restorePlatform();
  }
});

test("GitExecutable: default platform resolves git successfully", () => {
  // On the real (Linux) platform, `which git` succeeds and returns a path.
  // This is the contrast that proves the win32 test took a different branch.
  const resolved = resolveGitExecutable();
  assert.ok(resolved.length > 0, "resolveGitExecutable must return a path on Linux");
  assert.ok(
    resolved.includes("git"),
    `the resolved path must contain 'git', got: ${resolved}`,
  );
});

test("GitExecutable: explicit override bypasses platform lookup", () => {
  // An explicit override returns immediately regardless of platform.
  setPlatform("win32");
  try {
    // Use a path we know exists: node itself (as a stand-in).
    const { execPath } = process;
    const resolved = resolveGitExecutable(execPath);
    assert.equal(resolved, execPath, "explicit override must be returned verbatim");
  } finally {
    restorePlatform();
  }
});
