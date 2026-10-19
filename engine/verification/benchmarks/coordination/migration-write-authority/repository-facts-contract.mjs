import { canonicalJson } from "../../../../src/kernel/integrity.ts";

export const REPOSITORY_FACTS_SCENARIOS = Object.freeze([
  "ordinary-main-linked",
  "detached-linked-unicode-path",
  "separate-git-directory",
  "bare-with-linked-worktree",
  "unborn-main",
]);

export const REPOSITORY_FACTS_COMMANDS = Object.freeze([
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  ["rev-parse", "--path-format=absolute", "--git-dir"],
  ["rev-parse", "--absolute-git-dir"],
  ["rev-parse", "--show-toplevel"],
  ["rev-parse", "--is-bare-repository"],
  ["rev-parse", "--is-inside-work-tree"],
  ["rev-parse", "--show-object-format=storage"],
  ["rev-parse", "--verify", "HEAD"],
  ["symbolic-ref", "-q", "HEAD"],
  ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
  ["rev-parse", "--path-format=absolute", "--git-path", "refs"],
  ["rev-parse", "--path-format=absolute", "--git-path", "index"],
  ["config", "--get", "core.repositoryformatversion"],
]);

export const REPOSITORY_FACTS_ROLES = Object.freeze({
  "ordinary-main-linked": Object.freeze(["main", "linked"]),
  "detached-linked-unicode-path": Object.freeze(["main", "detached-linked"]),
  "separate-git-directory": Object.freeze(["main", "linked"]),
  "bare-with-linked-worktree": Object.freeze(["bare", "linked"]),
  "unborn-main": Object.freeze(["unborn-observer-a", "unborn-observer-b"]),
});

const ENVIRONMENT_KEYS = Object.freeze([
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
  "HOME", "LANG", "LC_ALL", "PATH",
]);

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function successfulValue(event, label) {
  if (event.status !== 0 || event.signal !== null || event.stderr !== "" ||
    !event.stdout.endsWith("\n") || event.stdout.slice(0, -1).includes("\n")) {
    fail("repository_command_success_envelope_invalid", label);
  }
  return event.stdout.slice(0, -1);
}

function failedValue(event, expectedStatus, expectedStderr, label) {
  if (event.status !== expectedStatus || event.signal !== null || event.stdout !== "" ||
    event.stderr !== expectedStderr) {
    fail("repository_command_failure_envelope_invalid", label);
  }
  return null;
}

function assertPathSnapshot(snapshot, expectedPath, expectedKind, label) {
  if (snapshot.canonicalPath !== expectedPath || snapshot.kind !== expectedKind) {
    fail("repository_path_snapshot_derivation_invalid", label);
  }
}

export function assertRepositoryFactsDerivedFromCommands(scenarioId, role, facts) {
  if (canonicalJson(REPOSITORY_FACTS_ROLES[scenarioId] ?? []) === "[]" ||
    !REPOSITORY_FACTS_ROLES[scenarioId].includes(role)) fail("repository_role_invalid", `${scenarioId}:${role}`);
  if (canonicalJson(facts.acquisition.environmentKeys) !== canonicalJson(ENVIRONMENT_KEYS)) {
    fail("repository_environment_contract_invalid", `${scenarioId}:${role}`);
  }
  const commands = facts.acquisition.commands;
  if (commands.length !== REPOSITORY_FACTS_COMMANDS.length) fail("repository_command_count_invalid", `${scenarioId}:${role}`);
  for (let index = 0; index < commands.length; index += 1) {
    const event = commands[index];
    if (canonicalJson(event.argv.slice(2)) !== canonicalJson(REPOSITORY_FACTS_COMMANDS[index]) ||
      event.argv[0] !== "-C" || event.argv[1] !== facts.repositoryLocator) {
      fail("repository_command_binding_invalid", `${scenarioId}:${role}:${index}`);
    }
  }

  const common = successfulValue(commands[0], `${scenarioId}:${role}:common`);
  const gitDirectory = successfulValue(commands[1], `${scenarioId}:${role}:git-directory`);
  const absoluteGitDirectory = successfulValue(commands[2], `${scenarioId}:${role}:absolute-git-directory`);
  const worktree = role === "bare" ?
    failedValue(commands[3], 128, "fatal: this operation must be run in a work tree\n", `${scenarioId}:${role}:worktree`) :
    successfulValue(commands[3], `${scenarioId}:${role}:worktree`);
  const bare = successfulValue(commands[4], `${scenarioId}:${role}:bare`);
  const inside = successfulValue(commands[5], `${scenarioId}:${role}:inside-worktree`);
  const objectFormat = successfulValue(commands[6], `${scenarioId}:${role}:object-format`);
  const headObject = scenarioId === "unborn-main" ?
    failedValue(commands[7], 128, "fatal: Needed a single revision\n", `${scenarioId}:${role}:head-object`) :
    successfulValue(commands[7], `${scenarioId}:${role}:head-object`);
  const headRef = role === "detached-linked" || (scenarioId === "bare-with-linked-worktree" && role === "linked") ?
    failedValue(commands[8], 1, "", `${scenarioId}:${role}:head-ref`) :
    successfulValue(commands[8], `${scenarioId}:${role}:head-ref`);
  const objectStore = successfulValue(commands[9], `${scenarioId}:${role}:object-store`);
  const refsDirectory = successfulValue(commands[10], `${scenarioId}:${role}:refs-directory`);
  const index = successfulValue(commands[11], `${scenarioId}:${role}:index`);
  const repositoryFormat = successfulValue(commands[12], `${scenarioId}:${role}:repository-format`);

  if (gitDirectory !== absoluteGitDirectory) fail("repository_git_directory_commands_disagree", `${scenarioId}:${role}`);
  assertPathSnapshot(facts.commonDirectory, common, "directory", `${scenarioId}:${role}:common`);
  assertPathSnapshot(facts.gitDirectory, gitDirectory, "directory", `${scenarioId}:${role}:git-directory`);
  assertPathSnapshot(facts.objectStore, objectStore, "directory", `${scenarioId}:${role}:object-store`);
  assertPathSnapshot(facts.refsDirectory, refsDirectory, "directory", `${scenarioId}:${role}:refs-directory`);
  if (worktree === null) {
    if (facts.worktreeRoot !== null) fail("repository_worktree_typed_absence_invalid", `${scenarioId}:${role}`);
  } else assertPathSnapshot(facts.worktreeRoot, worktree, "directory", `${scenarioId}:${role}:worktree`);
  if (facts.index.kind === "absent") {
    if (facts.index.path !== index) fail("repository_index_absence_path_invalid", `${scenarioId}:${role}`);
  } else assertPathSnapshot(facts.index, index, "file", `${scenarioId}:${role}:index`);
  if (facts.repositoryState.bare !== (bare === "true") ||
    facts.repositoryState.insideWorktree !== (inside === "true") ||
    facts.repositoryState.objectFormat !== objectFormat ||
    facts.repositoryState.repositoryFormatVersion !== repositoryFormat) {
    fail("repository_state_command_derivation_invalid", `${scenarioId}:${role}`);
  }
  const expectedHead = headObject === null ? { kind: "unborn", symbolicRef: headRef } :
    headRef === null ? { kind: "detached", objectId: headObject } :
      { kind: "symbolic", objectId: headObject, symbolicRef: headRef };
  if (canonicalJson(facts.repositoryState.head) !== canonicalJson(expectedHead)) {
    fail("repository_head_command_derivation_invalid", `${scenarioId}:${role}`);
  }
  if (scenarioId === "detached-linked-unicode-path" && role === "detached-linked" &&
    (!facts.repositoryLocator.includes("e\u0301") || facts.repositoryLocator.includes("é"))) {
    fail("repository_unicode_path_bytes_not_preserved", `${scenarioId}:${role}`);
  }
}

export function deriveScenarioAssertions(scenarioId, observations) {
  const [left, right] = observations;
  if (!left || !right || observations.length !== 2) fail("repository_scenario_observation_count_invalid", scenarioId);
  const assertions = [];
  const check = (id, condition, detail) => assertions.push({ id, ok: Boolean(condition), detail });
  check("common-directory-canonical-path-equal",
    left.facts.commonDirectory.canonicalPath === right.facts.commonDirectory.canonicalPath,
    "both processes/worktrees resolve one canonical Git common directory");
  check("common-directory-path-stat-snapshot-equal",
    canonicalJson(left.facts.commonDirectory) === canonicalJson(right.facts.commonDirectory),
    "common directory lstat plus realpath path snapshots agree exactly");
  check("object-store-path-stat-snapshot-equal",
    canonicalJson(left.facts.objectStore) === canonicalJson(right.facts.objectStore),
    "object-store lstat plus realpath path snapshots agree exactly");
  check("object-format-equal",
    left.facts.repositoryState.objectFormat === right.facts.repositoryState.objectFormat,
    "object format agrees");
  if (scenarioId !== "unborn-main") check("git-directory-role-separation",
    scenarioId === "bare-with-linked-worktree" || left.facts.gitDirectory.canonicalPath !== right.facts.gitDirectory.canonicalPath,
    "linked worktree Git directory is distinct from its peer where the scenario requires it");
  if (scenarioId === "separate-git-directory") check("common-directory-outside-worktree-root",
    !left.facts.commonDirectory.canonicalPath.startsWith(`${left.facts.worktreeRoot.canonicalPath}/`),
    "separate-git-dir can place shared metadata outside the main worktree root");
  if (scenarioId === "ordinary-main-linked" || scenarioId === "detached-linked-unicode-path") {
    check("main-common-directory-inside-main-worktree-root",
      left.facts.commonDirectory.canonicalPath.startsWith(`${left.facts.worktreeRoot.canonicalPath}/`),
      "ordinary repositories place the common directory at main/.git");
  }
  if (scenarioId === "bare-with-linked-worktree") check("bare-state-observed",
    left.facts.repositoryState.bare && left.facts.worktreeRoot === null && !left.facts.repositoryState.insideWorktree,
    "bare repository has no worktree root");
  if (scenarioId === "unborn-main") check("unborn-state-observed",
    left.facts.repositoryState.head.kind === "unborn" && right.facts.repositoryState.head.kind === "unborn",
    "unborn HEAD is explicit typed state");
  return Object.freeze(assertions.map((entry) => Object.freeze(entry)));
}
