import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_TYPECHECK_TIMEOUT_MS,
  resolveTypecheckTimeoutMs,
} from "../../src/workflow/harness-commands.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";

/**
 * Regression test for FIX-2 (MAJOR): hardcoded subprocess timeouts bypass config.
 *
 * Root cause: `runTypecheck` in `harness-commands.ts` used an inline literal
 * timeout (`120_000` for tsc). The `harness` config section exists for it,
 * but was not consumed.
 *
 * Fix: the function now calls `resolveTypecheckTimeoutMs`, which reads the
 * central config document with fallback to a named default constant. (The
 * git add/commit timeouts' consumer was the deleted `harness integrate`; the
 * workspace command is their consumer now, asserted below.)
 */

const ROOT = process.cwd();

test("resolveTypecheckTimeoutMs: returns the configured harness.typecheckTimeoutMs", () => {
  const snapshot = loadPinnedConfigSnapshot();
  const configured = snapshot.document.harness?.typecheckTimeoutMs;
  assert.ok(typeof configured === "number", "the config document must set harness.typecheckTimeoutMs");
  const resolved = resolveTypecheckTimeoutMs();
  assert.equal(resolved, configured, "resolveTypecheckTimeoutMs must return the configured value");
});

test("resolveTypecheckTimeoutMs: default constant is a sensible positive number", () => {
  assert.ok(DEFAULT_TYPECHECK_TIMEOUT_MS > 0, "default typecheck timeout must be positive");
  assert.ok(Number.isFinite(DEFAULT_TYPECHECK_TIMEOUT_MS), "default typecheck timeout must be finite");
});

test("harness-commands source: runTypecheck consumes its config resolver, not an inline literal", () => {
  // Contract test: the source must not contain hardcoded timeout literals
  // in the runTypecheck function. The resolver must be called.
  // This catches a regression where someone re-introduces an inline literal.
  const source = readFileSync(join(ROOT, "src", "workflow", "harness-commands.ts"), "utf8");
  // Locate the runTypecheck function body.
  const runTypecheckStart = source.indexOf("async function runTypecheck(");
  assert.ok(runTypecheckStart !== -1, "runTypecheck function must exist");
  const runTypecheckEnd = source.indexOf("\n}\n", runTypecheckStart);
  const runTypecheckBody = source.slice(runTypecheckStart, runTypecheckEnd);
  assert.ok(
    /resolveTypecheckTimeoutMs\(\)/u.test(runTypecheckBody),
    "runTypecheck must call resolveTypecheckTimeoutMs() instead of using an inline literal",
  );
  assert.ok(
    !/timeout:\s*\d+_?000\b/u.test(runTypecheckBody),
    "runTypecheck must not contain an inline timeout literal",
  );
});

test("workspace-cli source: the workspace command resolves its timeouts from the pinned config document, not inline literals", () => {
  // The workspace command is the live consumer of the section's timeouts: it
  // threads addMs/inspectMs/commitMs into the workspace manager as the
  // worktree/inspect/merge-commit bounds. The contract: the command reads
  // them from the pinned config document (a fresh process per command run,
  // which is what the settings rows' next-run timing states) through the ONE
  // reader the promotion shares (`worktreeOperationTimeouts`,
  // workflow-config.ts), which falls back to the named default constants,
  // never an inline literal.
  const source = readFileSync(join(ROOT, "src", "workflow", "workspace-cli.ts"), "utf8");
  assert.ok(
    /worktreeOperationTimeouts\(snapshot\.document\)/u.test(source),
    "workspace-cli must resolve its timeouts through worktreeOperationTimeouts over the pinned config document",
  );
  const config = readFileSync(join(ROOT, "src", "workflow", "workflow-config.ts"), "utf8");
  const resolutionStart = config.indexOf("export function worktreeOperationTimeouts(");
  assert.ok(resolutionStart !== -1, "workflow-config.ts must own the worktree timeouts reader");
  const resolutionBody = config.slice(resolutionStart, config.indexOf("\n}\n", resolutionStart));
  assert.ok(
    /document\.workspaceGit\?\.timeouts/u.test(resolutionBody),
    "the reader must read the workspaceGit section's timeouts",
  );
  assert.ok(
    /timeouts\?\.addMs\s*\?\?\s*DEFAULT_WORKTREE_OPERATION_TIMEOUT_MS/u.test(resolutionBody),
    "the worktree timeout must resolve from workspaceGit.timeouts.addMs with the named default fallback",
  );
  assert.ok(
    /timeouts\?\.inspectMs\s*\?\?\s*DEFAULT_WORKSPACE_INSPECT_TIMEOUT_MS/u.test(resolutionBody),
    "the inspect timeout must resolve from workspaceGit.timeouts.inspectMs with the named default fallback",
  );
  assert.ok(
    /timeouts\?\.commitMs\s*\?\?\s*DEFAULT_MERGE_OPERATION_TIMEOUT_MS/u.test(resolutionBody),
    "the merge timeout must resolve from workspaceGit.timeouts.commitMs with the named default fallback",
  );
  // The pinned git executable is the ONE configured port's (worktree-port.ts
  // `configuredWorktreeGitPort`, shared with `harness promote` and the
  // workspace signal): the command builds its port there, and the port reads
  // workspaceGit.gitExecutablePath.
  assert.ok(
    /configuredWorktreeGitPort\(snapshot\.document\)/u.test(source),
    "the workspace command must build its git port through configuredWorktreeGitPort over the pinned document",
  );
  const port = readFileSync(join(ROOT, "src", "git", "worktree-port.ts"), "utf8");
  const owner = port.slice(port.indexOf("export function configuredWorktreeGitPort("), port.indexOf("export type WorktreeGitPortOptions"));
  assert.ok(
    /resolveGitExecutable\(document\.workspaceGit\?\.gitExecutablePath\)/u.test(owner),
    "the pinned git executable must resolve from workspaceGit.gitExecutablePath",
  );
  assert.ok(
    !/\d+_?000\b/u.test(resolutionBody),
    "the worktree timeouts reader must not carry an inline timeout literal",
  );
});
