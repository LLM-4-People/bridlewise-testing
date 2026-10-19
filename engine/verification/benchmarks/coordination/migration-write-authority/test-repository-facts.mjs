import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson } from "../../../../src/kernel/integrity.ts";
import { validateRepositoryFactsReport } from "./validate-repository-facts.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "../../../..");
const EVIDENCE = resolve(
  ROOT,
  "traceability/evidence/research/coordination/migration-write-authority/repository-facts/attempts/f627a88f-9b52-41d5-8865-aba1dad443ea/repository-facts-run.json",
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rebind(report) {
  const copy = clone(report);
  delete copy.reportIdentity;
  copy.reportIdentity = canonicalHash(copy);
  return copy;
}

function expectBlocked(name, mutate, boundary = "semantic") {
  const candidate = rebind(mutate(clone(BASELINE)));
  const options = boundary === "external-evidence-pin" ?
    { expectedReportIdentity: BASELINE.reportIdentity } : {};
  try {
    validateRepositoryFactsReport(candidate, options);
  } catch (error) {
    return Object.freeze({
      name,
      boundary,
      blocked: true,
      diagnosticCode: String(error.message).split(":", 1)[0],
    });
  }
  throw new Error(`mutant_false_green:${name}`);
}

function firstScenario(value, scenarioId) {
  return value.repetitions[0].scenarios.find((scenario) => scenario.scenarioId === scenarioId);
}

const BASELINE = JSON.parse(readFileSync(EVIDENCE, "utf8"));
const controls = [Object.freeze({
  name: "valid-baseline-with-external-report-pin",
  ...validateRepositoryFactsReport(BASELINE, { expectedReportIdentity: BASELINE.reportIdentity }),
})];
const mutants = [
  expectBlocked("missing-third-repetition", (value) => {
    value.repetitions.pop();
    value.summary.repetitionsObserved = 2;
    return value;
  }),
  expectBlocked("unknown-top-level-field", (value) => {
    value.unknown = true;
    return value;
  }),
  expectBlocked("false-assertion-hidden-by-pass", (value) => {
    value.repetitions[0].scenarios[0].assertions[0].ok = false;
    return value;
  }),
  expectBlocked("common-directory-identity-fork", (value) => {
    value.repetitions[0].scenarios[0].processes[1].facts.commonDirectory.inode = "1";
    return value;
  }),
  expectBlocked("scenario-order-fork", (value) => {
    value.repetitions[0].scenarios.reverse();
    return value;
  }),
  expectBlocked("command-contract-widened", (value) => {
    value.repetitions[0].scenarios[0].processes[0].facts.acquisition.commands[0].argv.push("--show-prefix");
    return value;
  }),
  expectBlocked("command-repository-rebound", (value) => {
    value.repetitions[0].scenarios[0].processes[0].facts.acquisition.commands[0].argv[1] = "$DISPOSABLE/other";
    return value;
  }),
  expectBlocked("successful-command-stderr", (value) => {
    value.repetitions[0].scenarios[0].processes[0].facts.acquisition.commands[0].stderr = "warning\n";
    return value;
  }),
  expectBlocked("arbitrary-optional-failure-envelope", (value) => {
    const command = firstScenario(value, "bare-with-linked-worktree").processes[0].facts.acquisition.commands[3];
    command.status = 77;
    command.stderr = "invented\n";
    return value;
  }),
  expectBlocked("runner-identity-forged", (value) => {
    value.runner.sha256 = "0".repeat(64);
    return value;
  }),
  expectBlocked("contract-source-identity-forged", (value) => {
    value.runner.contractSha256 = "0".repeat(64);
    return value;
  }),
  expectBlocked("node-executable-identity-forged", (value) => {
    value.capabilities.node.sha256 = "0".repeat(64);
    value.capabilities.node.byteLength = 1;
    value.capabilities.nodeVersion = "v1.0.0";
    return value;
  }),
  expectBlocked("git-executable-identity-forged", (value) => {
    value.capabilities.git.sha256 = "0".repeat(64);
    value.capabilities.git.byteLength = 1;
    value.capabilities.gitVersion = "git version 1.0.0";
    return value;
  }),
  expectBlocked("assertions-replaced-with-unrelated-true-statements", (value) => {
    value.repetitions[0].scenarios[0].assertions = value.repetitions[0].scenarios[0].assertions.map(
      (entry, index) => ({ ...entry, id: `invented-${index}`, detail: "unrelated", ok: true }),
    );
    return value;
  }),
  expectBlocked("detached-state-forged-symbolic", (value) => {
    const facts = firstScenario(value, "detached-linked-unicode-path").processes[1].facts;
    facts.repositoryState.head = {
      kind: "symbolic",
      objectId: facts.acquisition.commands[7].stdout.trim(),
      symbolicRef: "refs/heads/invented",
    };
    return value;
  }),
  expectBlocked("bare-state-forged-non-bare", (value) => {
    firstScenario(value, "bare-with-linked-worktree").processes[0].facts.repositoryState.bare = false;
    return value;
  }),
  expectBlocked("unborn-state-forged-symbolic", (value) => {
    firstScenario(value, "unborn-main").processes[0].facts.repositoryState.head = {
      kind: "symbolic",
      objectId: "1".repeat(40),
      symbolicRef: "refs/heads/main",
    };
    return value;
  }),
  expectBlocked("decomposed-unicode-normalized", (value) => {
    const process = firstScenario(value, "detached-linked-unicode-path").processes[1];
    const before = "e\u0301";
    const after = "é";
    process.facts.repositoryLocator = process.facts.repositoryLocator.replaceAll(before, after);
    for (const command of process.facts.acquisition.commands) {
      command.argv = command.argv.map((part) => part.replaceAll(before, after));
      command.stdout = command.stdout.replaceAll(before, after);
    }
    for (const key of ["commonDirectory", "gitDirectory", "objectStore", "refsDirectory", "worktreeRoot", "index"]) {
      const snapshot = process.facts[key];
      if (snapshot?.canonicalPath) snapshot.canonicalPath = snapshot.canonicalPath.replaceAll(before, after);
      if (snapshot?.path) snapshot.path = snapshot.path.replaceAll(before, after);
    }
    return value;
  }),
  expectBlocked("coherent-command-and-common-directory-forgery", (value) => {
    const scenario = firstScenario(value, "ordinary-main-linked");
    for (const process of scenario.processes) {
      process.facts.commonDirectory.canonicalPath += "-forged";
      process.facts.acquisition.commands[0].stdout = `${process.facts.commonDirectory.canonicalPath}\n`;
    }
    return value;
  }, "external-evidence-pin"),
  expectBlocked("linked-private-git-directory-collapsed", (value) => {
    const process = firstScenario(value, "ordinary-main-linked").processes[1];
    process.facts.gitDirectory = clone(process.facts.commonDirectory);
    process.facts.acquisition.commands[1].stdout = `${process.facts.gitDirectory.canonicalPath}\n`;
    process.facts.acquisition.commands[2].stdout = `${process.facts.gitDirectory.canonicalPath}\n`;
    return value;
  }, "external-evidence-pin"),
  expectBlocked("separate-git-directory-coherently-moved-inside-worktree", (value) => {
    const scenario = firstScenario(value, "separate-git-directory");
    const forged = `${scenario.processes[0].facts.worktreeRoot.canonicalPath}/.git`;
    for (const process of scenario.processes) {
      process.facts.commonDirectory.canonicalPath = forged;
      process.facts.acquisition.commands[0].stdout = `${forged}\n`;
    }
    scenario.assertions = [];
    scenario.passed = false;
    value.repetitions[0].passed = false;
    value.summary.passed = false;
    return value;
  }, "external-evidence-pin"),
  expectBlocked("process-clock-metadata-forged", (value) => {
    value.startedAt = "2020-01-01T00:00:00.000Z";
    value.finishedAt = "2020-01-01T00:00:01.000Z";
    return value;
  }, "external-evidence-pin"),
  expectBlocked("readiness-claim-injected", (value) => {
    value.summary.selectionOrReadinessClaim = true;
    return value;
  }),
  expectBlocked("unavailable-connector-substitution-hidden", (value) => {
    value.connectorAvailability.fallbackSubstitutionUsed = true;
    return value;
  }),
];

process.stdout.write(`${canonicalJson({
  schemaVersion: "migration-repository-facts-author-test/v2",
  status: "author-test-unadmitted",
  controls,
  mutants,
  summary: {
    controlsPassed: controls.length,
    mutantsBlocked: mutants.filter((entry) => entry.blocked).length,
    mutantsRequired: mutants.length,
    independentAcceptance: false,
  },
})}\n`);

if (process.argv[1] && realpathSync(process.argv[1]) !== realpathSync(SCRIPT_PATH)) {
  throw new Error("direct_execution_identity_invalid");
}
