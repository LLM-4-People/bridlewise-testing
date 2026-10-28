import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { configuredSubprocessBounds, subprocessBounds } from "../../src/workflow/workflow-config.ts";

/**
 * The typecheck has NO wall limit (NO-LOAD-BLOCK A-17): `runTypecheck` runs
 * tsc through the harness's one subprocess bound (CPU work per process and
 * one hang backstop, through the one bounded run `runCpuBounded`, src/process/subprocess-bounds.ts), and the config's
 * old `harness.typecheckTimeoutMs` (120 s of wall) is gone. (The git
 * add/commit timeouts' consumer was the deleted `harness integrate`; the
 * workspace command is their consumer now, asserted below.)
 */

const ROOT = process.cwd();

test("the typecheck is bounded by CPU work, never a wall limit: no typecheckTimeoutMs in the config, the bound is the shared one", () => {
  assert.equal((loadPinnedConfigSnapshot().document.harness as Record<string, unknown> | undefined)?.["typecheckTimeoutMs"], undefined);
  const source = readFileSync(join(ROOT, "src", "workflow", "harness-commands.ts"), "utf8");
  const start = source.indexOf("export async function runTypecheck(");
  assert.ok(start !== -1, "runTypecheck function must exist");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  assert.match(body, /runCpuBounded\(/u, "runTypecheck must run tsc through the one subprocess bound");
  assert.doesNotMatch(body, /timeout:/u, "runTypecheck must not carry a wall timeout of its own");
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

test("the harness subprocess bounds are SETTINGS: harness.subprocessBounds is read field by field, an unset field is its declared default, the shipped file states every default, and an impossible value is refused by the schema", () => {
  const DEFAULT_SUBPROCESS_BOUNDS = subprocessBounds({});
  assert.deepEqual(DEFAULT_SUBPROCESS_BOUNDS, { cpuBudgetMs: 1_800_000, minimumCpuRate: 0.05, stallMs: 1_800_000, hangBackstopMs: 7_200_000, pollMs: 1_000, killGraceMs: 5_000, outputBytes: 268_435_456 }, "an absent section answers the declared defaults");
  const one = subprocessBounds({ harness: { subprocessBounds: { stallMs: 123_456 } } });
  assert.equal(one.stallMs, 123_456, "a configured field is the value every consumer gets");
  assert.deepEqual({ ...one, stallMs: DEFAULT_SUBPROCESS_BOUNDS.stallMs }, DEFAULT_SUBPROCESS_BOUNDS, "the fields left unset keep their defaults");
  // The shipped document states each bound (expose everything), and they are the declared defaults.
  assert.deepEqual(loadPinnedConfigSnapshot().document.harness?.subprocessBounds, { ...DEFAULT_SUBPROCESS_BOUNDS });
  assert.deepEqual(configuredSubprocessBounds(), DEFAULT_SUBPROCESS_BOUNDS);
  const schema = getConfigDocumentSchema();
  const shipped = loadPinnedConfigSnapshot().document;
  for (const [field, value] of [["minimumCpuRate", 0], ["minimumCpuRate", 1.5], ["stallMs", 0], ["hangBackstopMs", -1], ["pollMs", 1.5], ["outputBytes", 1], ["unknownBound", 1]] as const) {
    const document = { ...shipped, harness: { ...shipped.harness, subprocessBounds: { ...shipped.harness?.subprocessBounds, [field]: value } } };
    assert.equal(schema.safeParse(document).success, false, `harness.subprocessBounds.${field} = ${String(value)} is refused`);
  }
});
