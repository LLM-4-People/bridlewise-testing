import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { canonicalHash, canonicalJson, sha256 } from "../../../../src/kernel/integrity.ts";
import {
  deriveScenarioAssertions,
  REPOSITORY_FACTS_SCENARIOS,
} from "./repository-facts-contract.mjs";

const SCHEMA_VERSION = "migration-repository-facts-run/v1";
const PROTOCOL_VERSION = "migration-repository-facts-protocol/v1";
const EVIDENCE_RELATIVE_ROOT =
  "traceability/evidence/research/coordination/migration-write-authority/repository-facts";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../../../..");
const CONTRACT_SOURCE_PATH = resolve(dirname(SCRIPT_PATH), "repository-facts-contract.mjs");

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  const values = new Map();
  for (const argument of rest) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("argument_invalid", argument);
    const key = argument.slice(2, separator);
    if (values.has(key)) fail("argument_duplicate", key);
    values.set(key, argument.slice(separator + 1));
  }
  return { mode, values };
}

function requireExactKeys(values, expected) {
  const actual = [...values.keys()].toSorted();
  const wanted = [...expected].toSorted();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail("argument_set_invalid", canonicalJson({ actual, expected: wanted }));
  }
}

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function requireAbsoluteRegularExecutable(input, label) {
  if (!isAbsolute(input)) fail(`${label}_path_not_absolute`, input);
  const lexical = resolve(input);
  const canonical = realpathSync(lexical);
  const stats = statSync(canonical, { bigint: true });
  if (!stats.isFile() || (stats.mode & 0o111n) === 0n) fail(`${label}_not_executable`, canonical);
  return Object.freeze({
    lexicalPath: lexical,
    canonicalPath: canonical,
    byteLength: Number(stats.size),
    sha256: sha256(readFileSync(canonical)),
    identity: fileIdentity(stats),
  });
}

function fileIdentity(stats) {
  return Object.freeze({
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: Number(stats.mode & 0o7777n),
    ownerUid: stats.uid.toString(),
    ownerGid: stats.gid.toString(),
    links: stats.nlink.toString(),
  });
}

function pathStatIdentity(path) {
  const stats = lstatSync(path, { bigint: true });
  const kind = stats.isDirectory() ? "directory" : stats.isFile() ? "file" :
    stats.isSymbolicLink() ? "symlink" : "other";
  return Object.freeze({
    canonicalPath: realpathSync(path),
    kind,
    ...fileIdentity(stats),
  });
}

function closedEnvironment(home) {
  return Object.freeze({
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  });
}

function execute(executable, argv, options = {}) {
  const result = spawnSync(executable, argv, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    windowsHide: true,
  });
  const status = result.status;
  const signal = result.signal;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.error) fail("command_launch_failed", `${argv[0]}:${result.error.message}`);
  if (!options.allowFailure && (status !== 0 || signal !== null || stderr.length > 0)) {
    fail("command_failed", canonicalJson({ argv, signal, status, stderr, stdout }));
  }
  return Object.freeze({ argv: Object.freeze([...argv]), signal, status, stderr, stdout });
}

function git(executable, home, repository, args, allowFailure = false) {
  return execute(executable, ["-C", repository, ...args], {
    allowFailure,
    cwd: repository,
    env: closedEnvironment(home),
  });
}

function gitValue(executable, home, repository, args, optional = false) {
  const event = git(executable, home, repository, args, optional);
  if (event.status !== 0) return Object.freeze({ event, value: null });
  if (event.stderr.length > 0) fail("git_unexpected_stderr", canonicalJson(event));
  return Object.freeze({ event, value: event.stdout.trimEnd() });
}

function acquireFacts(executable, home, repository) {
  const commands = [];
  const query = (args, optional = false) => {
    const result = gitValue(executable, home, repository, args, optional);
    commands.push(result.event);
    return result.value;
  };
  const commonDirectory = query(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const gitDirectory = query(["rev-parse", "--path-format=absolute", "--git-dir"]);
  const absoluteGitDirectory = query(["rev-parse", "--absolute-git-dir"]);
  const worktreeRoot = query(["rev-parse", "--show-toplevel"], true);
  const bare = query(["rev-parse", "--is-bare-repository"]);
  const insideWorktree = query(["rev-parse", "--is-inside-work-tree"]);
  const objectFormat = query(["rev-parse", "--show-object-format=storage"]);
  const headObject = query(["rev-parse", "--verify", "HEAD"], true);
  const headRef = query(["symbolic-ref", "-q", "HEAD"], true);
  const objectStore = query(["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  const refsDirectory = query(["rev-parse", "--path-format=absolute", "--git-path", "refs"]);
  const indexPath = query(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const repositoryFormatVersion = query(["config", "--get", "core.repositoryformatversion"], true);

  if (!commonDirectory || !gitDirectory || !absoluteGitDirectory || !objectStore || !refsDirectory ||
    !indexPath || !bare || !insideWorktree || !objectFormat) {
    fail("repository_fact_missing", repository);
  }
  const commonCanonical = realpathSync(commonDirectory);
  const gitCanonical = realpathSync(gitDirectory);
  if (gitCanonical !== realpathSync(absoluteGitDirectory)) {
    fail("git_directory_fact_disagreement", repository);
  }
  return Object.freeze({
    schemaVersion: "migration-repository-facts/v1",
    repositoryLocator: repository,
    commonDirectory: pathStatIdentity(commonCanonical),
    gitDirectory: pathStatIdentity(gitCanonical),
    objectStore: pathStatIdentity(objectStore),
    refsDirectory: pathStatIdentity(refsDirectory),
    worktreeRoot: worktreeRoot === null ? null : pathStatIdentity(worktreeRoot),
    index: lstatSync(indexPath, { throwIfNoEntry: false }) === undefined ?
      Object.freeze({ kind: "absent", parent: pathStatIdentity(dirname(indexPath)), path: indexPath }) :
      pathStatIdentity(indexPath),
    repositoryState: Object.freeze({
      bare: bare === "true",
      insideWorktree: insideWorktree === "true",
      objectFormat,
      repositoryFormatVersion: repositoryFormatVersion ?? "0",
      head: headObject === null ? Object.freeze({ kind: "unborn", symbolicRef: headRef }) :
        headRef === null ? Object.freeze({ kind: "detached", objectId: headObject }) :
        Object.freeze({ kind: "symbolic", objectId: headObject, symbolicRef: headRef }),
    }),
    acquisition: Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      commands: Object.freeze(commands),
      environmentKeys: Object.freeze(Object.keys(closedEnvironment(home)).toSorted()),
    }),
  });
}

function initializeRepository(gitExecutable, home, root, options = {}) {
  const worktree = join(root, options.name ?? "main worktree");
  const args = ["init", "--quiet", "--initial-branch=main"];
  if (options.separateGitDirectory) args.push(`--separate-git-dir=${options.separateGitDirectory}`);
  args.push(worktree);
  execute(gitExecutable, args, { cwd: root, env: closedEnvironment(home) });
  if (options.unborn) return worktree;
  writeFileSync(join(worktree, "fixture.txt"), "migration authority repository facts\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  git(gitExecutable, home, worktree, ["add", "--", "fixture.txt"]);
  git(gitExecutable, home, worktree, [
    "-c", "user.name=Qualification",
    "-c", "user.email=qualification.invalid@example.invalid",
    "-c", "commit.gpgSign=false",
    "commit", "--no-verify", "--no-gpg-sign", "-m", "qualification fixture",
  ]);
  return worktree;
}

function addLinkedWorktree(gitExecutable, home, main, linked, detached) {
  const args = ["worktree", "add", "--quiet"];
  if (detached) args.push("--detach", linked, "HEAD");
  else args.push("-b", `qualification-${sha256(linked).slice(0, 12)}`, linked, "HEAD");
  git(gitExecutable, home, main, args);
}

function setupScenario(gitExecutable, home, root, scenarioId) {
  if (scenarioId === "ordinary-main-linked") {
    const main = initializeRepository(gitExecutable, home, root);
    const linked = join(root, "linked worktree");
    addLinkedWorktree(gitExecutable, home, main, linked, false);
    return [{ role: "main", repository: main }, { role: "linked", repository: linked }];
  }
  if (scenarioId === "detached-linked-unicode-path") {
    const main = initializeRepository(gitExecutable, home, root, { name: "main Ω worktree" });
    const linked = join(root, "detached e\u0301 worktree");
    addLinkedWorktree(gitExecutable, home, main, linked, true);
    return [{ role: "main", repository: main }, { role: "detached-linked", repository: linked }];
  }
  if (scenarioId === "separate-git-directory") {
    const separate = join(root, "shared git metadata");
    const main = initializeRepository(gitExecutable, home, root, { separateGitDirectory: separate });
    const linked = join(root, "separate linked");
    addLinkedWorktree(gitExecutable, home, main, linked, false);
    return [{ role: "main", repository: main }, { role: "linked", repository: linked }];
  }
  if (scenarioId === "bare-with-linked-worktree") {
    const source = initializeRepository(gitExecutable, home, root, { name: "seed" });
    const bare = join(root, "bare repository.git");
    execute(gitExecutable, ["clone", "--quiet", "--bare", "--no-local", source, bare], {
      cwd: root,
      env: closedEnvironment(home),
    });
    const linked = join(root, "bare linked");
    addLinkedWorktree(gitExecutable, home, bare, linked, true);
    return [{ role: "bare", repository: bare }, { role: "linked", repository: linked }];
  }
  if (scenarioId === "unborn-main") {
    const main = initializeRepository(gitExecutable, home, root, { unborn: true });
    return [{ role: "unborn-observer-a", repository: main }, { role: "unborn-observer-b", repository: main }];
  }
  fail("scenario_unknown", scenarioId);
}

function childObservation(gitExecutable, home, entry) {
  const result = execute(process.execPath, [
    SCRIPT_PATH,
    "worker",
    `--git-executable=${gitExecutable}`,
    `--home=${home}`,
    `--repository=${entry.repository}`,
    `--role=${entry.role}`,
  ], {
    cwd: REPOSITORY_ROOT,
    env: closedEnvironment(home),
  });
  if (result.status !== 0 || result.signal !== null || result.stderr.length > 0) {
    fail("worker_failed", canonicalJson(result));
  }
  return JSON.parse(result.stdout);
}

function sanitizeValue(value, root) {
  if (typeof value === "string") return value.split(root).join("$DISPOSABLE");
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, root));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, root)]));
  }
  return value;
}

function publishEvidence(report, attemptId) {
  const evidenceRoot = resolve(REPOSITORY_ROOT, EVIDENCE_RELATIVE_ROOT);
  const attemptsRoot = join(evidenceRoot, "attempts");
  const attemptRoot = join(attemptsRoot, attemptId);
  mkdirSync(attemptRoot, { recursive: true, mode: 0o700 });
  chmodSync(evidenceRoot, 0o700);
  chmodSync(attemptsRoot, 0o700);
  chmodSync(attemptRoot, 0o700);
  const destination = join(attemptRoot, "repository-facts-run.json");
  const bytes = `${canonicalJson(report)}\n`;
  writeFileSync(destination, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return Object.freeze({
    relativePath: relative(REPOSITORY_ROOT, destination),
    byteLength: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
    admission: "exclusive-local-research-evidence-unadmitted",
  });
}

function runWorker(values) {
  requireExactKeys(values, ["git-executable", "home", "repository", "role"]);
  const facts = acquireFacts(values.get("git-executable"), values.get("home"), values.get("repository"));
  process.stdout.write(`${canonicalJson({ role: values.get("role"), processId: process.pid, facts })}\n`);
}

function runQualification(values) {
  requireExactKeys(values, ["git-executable"]);
  const gitExecutable = requireAbsoluteRegularExecutable(values.get("git-executable"), "git_executable");
  const nodeExecutable = requireAbsoluteRegularExecutable(process.execPath, "node_executable");
  const versionHome = mkdtempSync(join(tmpdir(), "mwa-git-version-"));
  const startedAt = new Date().toISOString();
  const attemptId = randomUUID();
  try {
    const gitVersion = execute(gitExecutable.canonicalPath, ["--version"], {
      cwd: versionHome,
      env: closedEnvironment(versionHome),
    });
    const scenarioIds = REPOSITORY_FACTS_SCENARIOS;
    const repetitions = [];
    for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
      const disposableRoot = mkdtempSync(join(tmpdir(), `mwa-repository-facts-${ordinal}-`));
      const home = join(disposableRoot, "home");
      mkdirSync(home, { mode: 0o700 });
      const scenarios = [];
      try {
        for (const scenarioId of scenarioIds) {
          const scenarioRoot = join(disposableRoot, scenarioId);
          mkdirSync(scenarioRoot, { mode: 0o700 });
          const entries = setupScenario(gitExecutable.canonicalPath, home, scenarioRoot, scenarioId);
          const observations = entries.map((entry) => childObservation(gitExecutable.canonicalPath, home, entry));
          const assertions = deriveScenarioAssertions(scenarioId, observations);
          scenarios.push(sanitizeValue({
            scenarioId,
            processes: observations,
            assertions,
            passed: assertions.every((assertion) => assertion.ok),
          }, disposableRoot));
        }
        repetitions.push(Object.freeze({
          ordinal,
          scenarios: Object.freeze(scenarios),
          passed: scenarios.every((scenario) => scenario.passed),
        }));
      } finally {
        rmSync(disposableRoot, { force: true, recursive: true });
      }
    }
    const runnerBytes = readFileSync(SCRIPT_PATH);
    const reportWithoutIdentity = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      status: "observed-unadmitted",
      attemptId,
      startedAt,
      finishedAt: new Date().toISOString(),
      protocolVersion: PROTOCOL_VERSION,
      runner: Object.freeze({
        relativePath: relative(REPOSITORY_ROOT, SCRIPT_PATH),
        sha256: sha256(runnerBytes),
        contractRelativePath: relative(REPOSITORY_ROOT, CONTRACT_SOURCE_PATH),
        contractSha256: sha256(readFileSync(CONTRACT_SOURCE_PATH)),
      }),
      capabilities: Object.freeze({
        node: nodeExecutable,
        nodeVersion: process.version,
        git: gitExecutable,
        gitVersion: gitVersion.stdout.trimEnd(),
      }),
      connectorAvailability: Object.freeze({
        context7: "unavailable",
        deepwiki: "unavailable",
        kagi: "unavailable",
        scrapling: "unavailable",
        fallbackSubstitutionUsed: false,
      }),
      repetitions: Object.freeze(repetitions),
      summary: Object.freeze({
        repetitionsRequired: 3,
        repetitionsObserved: repetitions.length,
        scenariosPerRepetition: scenarioIds.length,
        childProcessesObserved: repetitions.reduce((sum, repetition) =>
          sum + repetition.scenarios.reduce((inner, scenario) => inner + scenario.processes.length, 0), 0),
        passed: repetitions.every((repetition) => repetition.passed),
        selectionOrReadinessClaim: false,
      }),
    });
    const report = Object.freeze({
      ...reportWithoutIdentity,
      reportIdentity: canonicalHash(reportWithoutIdentity),
    });
    const publication = publishEvidence(report, attemptId);
    process.stdout.write(`${canonicalJson({ publication, reportIdentity: report.reportIdentity, summary: report.summary })}\n`);
  } finally {
    rmSync(versionHome, { force: true, recursive: true });
  }
}

const { mode, values } = parseArguments(process.argv.slice(2));
if (mode === "worker") runWorker(values);
else if (mode === "run") runQualification(values);
else fail("mode_invalid", String(mode));
