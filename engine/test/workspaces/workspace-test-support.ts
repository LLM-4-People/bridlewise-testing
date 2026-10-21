import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import type { WorkspaceIsolationConfig } from "../../src/kernel/config-contracts.ts";
import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import type { GitIdentity } from "../../src/git/git-port.ts";
import { createPerOperationPinnedWorktreeGitExec, createWorktreeGitPort, type WorktreeGitPort } from "../../src/git/worktree-port.ts";
import { deepFreeze, generateId } from "../../src/kernel/integrity.ts";
import { appendJudgedRun, finalizeQualifiedRun, qualificationTerminal, suiteLedgerPaths, type SuiteLedgerName } from "../../src/shared/run-history.ts";
import type { JudgedRunRecord, GateOutcome } from "../../src/shared/budget-verdict.ts";
import type { SupervisedCommand } from "../../src/process/supervised-run.ts";
import type { CheckoutCommand } from "../../src/workflow/checkout-setup.ts";
import { DEFAULT_GIT_RUNTIME_MAXIMUM_BYTES } from "../../src/workflow/workflow-config.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";
import {
  createWorkspaceManager,
  type WorkspaceCommands,
  type WorkspaceGateOutcome,
  type WorkspaceManager,
  type WorkspaceManagerOptions,
  type WorkspaceManagerTimeouts,
} from "../../src/workflow/workspace-manager.ts";
import { repositoryRegistry, type RepositoryRegistry } from "../../src/workflow/repository-registry.ts";
import type { GitRepository } from "../../src/git/tree-reader.ts";
import type { WorkspaceForgeFactory } from "../../src/workflow/workspace-forge.ts";
import { createFakeForge, type FakeForge } from "./fake-forge.ts";

/**
 * Shared fixtures for workspace isolation tests: temporary git repositories
 * driven through raw git (fixture setup only — the port under test stays
 * pinned), a recording fake command runner (each configured command's
 * outcome is the test's to choose), and a manager factory wiring the real
 * pinned worktree port against the temp repository. The registry lives in
 * the temp repository's own git common dir, like a real one.
 */

const TEMPORARY_PATHS = new Set<string>();

test.after(() => {
  for (const path of TEMPORARY_PATHS) rmSync(path, { recursive: true, force: true });
});

export function mkWorkspaceTempDir(prefix: string): string {
  const root = createTempDir(`${prefix}-`);
  TEMPORARY_PATHS.add(root);
  return root;
}

export function rawGit(cwd: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}): string {
  return execFileSync("git", ["-c", "gc.auto=0", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...testGitIdentityEnvironment(),
      ...environment,
    },
  }).trim();
}

/**
 * A temporary repository on branch `main` with one commit (README and an
 * ignore file for the state directory), whose `main` tracks `origin/main` on
 * a bare repository: the forge's remote ({@link forgeAt} is its fake forge).
 */
export function initTempRepo(prefix: string): Readonly<{ root: string; baseSha: string; bare: string }> {
  const root = mkWorkspaceTempDir(prefix);
  rawGit(root, ["init", "-b", "main"]);
  writeFileSync(join(root, ".gitignore"), ".bridlewise/\nnode_modules/\n");
  writeFileSync(join(root, "README.md"), "# workspace test\n");
  rawGit(root, ["add", "."]);
  rawGit(root, ["commit", "-m", "init"]);
  const bare = mkWorkspaceTempDir(`${prefix}-forge`);
  rawGit(bare, ["init", "-q", "--bare", "-b", "main"]);
  rawGit(root, ["remote", "add", "origin", bare]);
  trackBranch(root, "main");
  return deepFreeze({ root, baseSha: rawGit(root, ["rev-parse", "HEAD"]), bare });
}

/** Publishes `branch` to `origin` (the forge's remote) and makes it the branch's upstream: a land target. */
export function trackBranch(root: string, branch: string): void {
  rawGit(root, ["push", "-q", "-u", "origin", `${branch}:${branch}`]);
}

/** The binary-safe git of a test checkout (PATH's git, the inspect ceiling). */
export function testRepository(root: string): GitRepository {
  return deepFreeze({ root, executable: resolveGitExecutable(), timeoutMs: TEST_TIMEOUTS.inspectMs });
}

const FORGES = new Map<string, FakeForge>();

/** The fake forge of the bare repository at `remoteUrl` (one per remote, so its pull requests outlive a manager). */
export function forgeAt(remoteUrl: string): FakeForge {
  let forge = FORGES.get(remoteUrl);
  if (forge === undefined) {
    forge = createFakeForge(remoteUrl, mkWorkspaceTempDir("fake-forge-scratch"));
    FORGES.set(remoteUrl, forge);
  }
  return forge;
}

/** The test factory: each target's remote answers through its {@link forgeAt} fake. */
export const fakeForgeFactory: WorkspaceForgeFactory = (target) => forgeAt(target.remoteUrl);

export function writeFile(repoRoot: string, relativePath: string, content: string): void {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

export function commitFile(repoRoot: string, relativePath: string, content: string, message?: string): string {
  writeFile(repoRoot, relativePath, content);
  rawGit(repoRoot, ["add", relativePath]);
  rawGit(repoRoot, ["commit", "-m", message ?? `update ${relativePath}`]);
  return rawGit(repoRoot, ["rev-parse", "HEAD"]);
}

/**
 * Commit the failure owners' tracker (`ROOT_POLICY.workflow.failureOwners.tracker`)
 * with ONE open task row naming each repository path: the owner the ledger
 * judge requires for a failure that persists from the target.
 */
export function commitFailureOwners(repoRoot: string, paths: readonly string[], task = "FIXTURE-OWNER"): string {
  return commitFile(repoRoot, ROOT_POLICY.workflow.failureOwners.tracker, `# Tasks\n\n- [ ] **${task}** owns ${paths.join(", ")}\n`);
}

export const TEST_INTEGRATOR_IDENTITY: GitIdentity = deepFreeze({
  name: "Test Integrator",
  email: "integrator@example.com",
});

export const TEST_TIMEOUTS: WorkspaceManagerTimeouts = deepFreeze({
  worktreeMs: 30_000,
  inspectMs: 30_000,
  mergeMs: 30_000,
  fetchMs: 30_000,
});

/** A declared command the fake runner answers for (its argv is never executed). */
const FAKE_COMMAND: CheckoutCommand = deepFreeze({ cwd: ".", argv: ["true"], timeoutMs: 60_000 });

/**
 * A test configuration: every phase names one fake command (`unit` validates,
 * `regen` regenerates, `suite` gates the merge; setup runs nothing), each
 * answered by {@link makeFakeCommands}.
 */
export function makeTestConfig(workspaceRoot: string, overrides: Partial<WorkspaceIsolationConfig> = {}): WorkspaceIsolationConfig {
  return deepFreeze({
    workspaceRoot,
    branchNamespace: "agent/",
    baseStalenessCommits: 50,
    preserveOnFailure: true,
    quarantineTtlMs: 60_000,
    leaseTtlMs: 3_600_000,
    admissionLock: deepFreeze({ name: "workspace-admission", timeoutMs: 2_000, staleMs: 30_000 }),
    mergeLock: deepFreeze({ name: "workspace-merge", timeoutMs: 2_000, staleMs: 30_000 }),
    // The fixtures' branches a workspace may land on; `product` never is (the
    // land-target refusal's tests use it).
    landTargets: deepFreeze(["main", "side", "testing", "other"]),
    killGraceMs: 1_000,
    links: [],
    commands: deepFreeze({ unit: FAKE_COMMAND, regen: FAKE_COMMAND, suite: FAKE_COMMAND }),
    phases: deepFreeze({ setup: [], validate: ["unit"], regenerate: ["regen"], merge: ["suite"] }),
    ...overrides,
  });
}

/** A typed fixture of a completed command; never offered as real process evidence. */
export function fixtureSupervisedCommand(exitCode: number, changes: Partial<SupervisedCommand> = {}): SupervisedCommand {
  return { exitCode, ending: "exited", elapsedMs: 1, status: exitCode, signal: null,
    outputComplete: true, orphanedGroupKilled: false,
    supervision: { commandPid: 123, status: exitCode, timedOut: false, interrupted: false,
      reaped: [], commandKilled: false, waitedCpuUs: 0, supervisorCpuUsBeforeReceipt: 0,
      killed: [], noOwnedChildren: true }, ...changes };
}

/** Drive the actual append/finalize/read contract for a fake workspace command. */
export function qualifiedSuiteGate(cwd: string, suite: SuiteLedgerName, record: JudgedRunRecord, options: Readonly<{
  outcomes?: readonly GateOutcome[]; complete?: boolean; terminal?: Partial<SupervisedCommand>; record?: boolean;
}> = {}): WorkspaceGateOutcome {
  const invocationId = generateId("qualification");
  const treeId = rawGit(cwd, ["rev-parse", "HEAD^{tree}"]);
  const outcomes = options.outcomes ?? [{ gate: "fixture-producer", kind: "pass", message: "all fixture results accounted" }];
  const exitCode = (record.failures?.length ?? 0) > 0 || outcomes.some((outcome) => outcome.kind === "fail") ? 1 : 0;
  const terminal = fixtureSupervisedCommand(exitCode, options.terminal);
  const path = join(cwd, suiteLedgerPaths("engine")[suite]);
  if (options.record !== false) {
    appendJudgedRun({ ...record, treeId, qualification: {
      schemaVersion: 1, invocationId, treeId, producer: suite,
      producerComplete: options.complete ?? true, outcomes,
    } }, path);
    finalizeQualifiedRun(path, invocationId, treeId, qualificationTerminal(invocationId, treeId, terminal));
  }
  return { step: "suite", status: exitCode === 0 ? "pass" : "fail", message: "typed fixture command completed", details: [],
    evidence: { argv: ["true"], cwd: ".", attempts: 1, durationMs: 1, load: 0, parallelism: 1, invocationId, terminal } };
}

export function passGate(step: string, message = `${step} passed`): WorkspaceGateOutcome {
  return deepFreeze({ step, status: "pass", message, details: deepFreeze([]) });
}

export function failGate(step: string, message = `${step} failed`): WorkspaceGateOutcome {
  return deepFreeze({ step, status: "fail", message, details: deepFreeze([]) });
}

/** One command call the fake runner saw. */
export type FakeCommandCall = Readonly<{ cwd: string; name: string }>;

/**
 * A fake runner: `answers[name]` decides a command's outcome (it may also act
 * on the checkout, e.g. a regenerate that writes a file); unnamed commands
 * pass. Every call is recorded in `calls`.
 */
export function makeFakeCommands(
  answers: Readonly<Record<string, (cwd: string) => WorkspaceGateOutcome>> = {},
): WorkspaceCommands & Readonly<{ calls: FakeCommandCall[] }> {
  const calls: FakeCommandCall[] = [];
  return {
    calls,
    run: async (cwd, name) => {
      calls.push(deepFreeze({ cwd, name }));
      return answers[name]?.(cwd) ?? passGate(name);
    },
  };
}

export type ManagerFixture = Readonly<{
  manager: WorkspaceManager;
  git: WorktreeGitPort;
}>;

export function makeGitPort(branchNamespace = "agent/"): WorktreeGitPort {
  return createWorktreeGitPort({ exec: createPerOperationPinnedWorktreeGitExec(resolveGitExecutable(), DEFAULT_GIT_RUNTIME_MAXIMUM_BYTES), branchNamespace });
}

export function makeManager(
  checkoutRoot: string,
  options: Readonly<{
    config: WorkspaceIsolationConfig;
    commands?: WorkspaceCommands;
    timeline?: WorkspaceManagerOptions["timeline"];
    records?: WorkspaceManagerOptions["records"];
    git?: WorktreeGitPort;
    now?: () => Date;
    engineRelative?: string;
    /** The forge factory (default: the fake forges); `null`: none configured. */
    forge?: WorkspaceForgeFactory | null;
  }>,
): ManagerFixture {
  const git = options.git ?? makeGitPort(options.config.branchNamespace);
  const manager = createWorkspaceManager({
    checkoutRoot,
    engineRelative: options.engineRelative ?? "engine",
    config: options.config,
    git,
    repository: testRepository,
    ...(options.forge === null ? {} : { forge: options.forge ?? fakeForgeFactory }),
    commands: options.commands ?? makeFakeCommands(),
    timeouts: TEST_TIMEOUTS,
    identity: TEST_INTEGRATOR_IDENTITY,
    timeline: options.timeline ?? null,
    ...(options.records !== undefined ? { records: options.records } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return deepFreeze({ manager, git });
}

/** The repository's registry, derived by the production owner from git's own common dir. */
export function registryOf(repoRoot: string): RepositoryRegistry {
  return repositoryRegistry(rawGit(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
}

/** The repository's registry directory (the manager's `<common dir>/bridlewise`). */
export function registryRoot(repoRoot: string): string {
  return registryOf(repoRoot).root;
}
