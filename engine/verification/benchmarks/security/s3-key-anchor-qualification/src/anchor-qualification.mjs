import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";
import { anchorRequest } from "./anchor-client.mjs";
import {
  GENESIS_TIP,
  appendCommitted,
  checkpoint,
  deleteTail,
  inspectLedger,
  markAnchored,
  openLedger,
} from "./ledger-lib.mjs";

process.umask(0o077);
const root = process.argv[2];
if (!root) throw new Error("work root is required");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true, mode: 0o700 });
const node = process.execPath;
const source = dirname(new URL(import.meta.url).pathname);

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function startAuthority(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const socketPath = join(directory, "anchor.sock");
  const statePath = join(directory, "anchor-state.json");
  const child = spawn(node, [join(source, "anchor-authority.mjs"), socketPath, statePath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "" },
  });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`authority startup timed out: ${errors.join("")}`)), 5_000);
    lines.once("line", (line) => {
      clearTimeout(timeout);
      try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
    });
    child.once("exit", (code, signal) => reject(new Error(`authority exited ${code}/${signal}: ${errors.join("")}`)));
  });
  if (!ready.ready) throw new Error("authority did not report ready");
  return { child, socketPath, statePath, ready, errors };
}

async function stopAuthority(authority, signal = "SIGTERM") {
  authority.child.kill(signal);
  return waitForExit(authority.child);
}

function statSummary(path) {
  const stat = lstatSync(path);
  return {
    mode: stat.mode & 0o7777,
    uid: stat.uid,
    gid: stat.gid,
    size: stat.size,
    regular: stat.isFile(),
    socket: stat.isSocket(),
    symlink: stat.isSymbolicLink(),
    nlink: stat.nlink,
  };
}

function durableWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

async function assess(databasePath, socketPath) {
  const ledger = inspectLedger(databasePath);
  const anchor = await anchorRequest(socketPath, { op: "read" });
  let classification;
  if (!ledger.valid || ledger.quickCheck !== "ok") classification = "invalid_ledger";
  else if (ledger.generation === anchor.generation && ledger.tip === anchor.tip) classification = "consistent";
  else if (ledger.generation < anchor.generation) classification = "anchor_ahead_rollback_or_tail_loss";
  else if (ledger.generation === anchor.generation + 1 &&
           ledger.rows.at(-1)?.previousTip === anchor.tip &&
           ledger.unanchoredSequences.includes(ledger.generation)) classification = "one_valid_unacknowledged_successor";
  else classification = "fork_or_unbounded_gap";
  return { classification, ledger, anchor };
}

async function finalizePending(databasePath, socketPath, assessment) {
  if (assessment.classification === "consistent" && assessment.ledger.unanchoredSequences.length === 1 &&
      assessment.ledger.unanchoredSequences[0] === assessment.ledger.generation) {
    markAnchored(databasePath, assessment.ledger.generation);
    return { action: "marked_after_anchor_response_loss" };
  }
  if (assessment.classification !== "one_valid_unacknowledged_successor") {
    return { action: "refused", classification: assessment.classification };
  }
  const row = assessment.ledger.rows.at(-1);
  const response = await anchorRequest(socketPath, {
    op: "cas",
    expectedGeneration: assessment.anchor.generation,
    expectedTip: assessment.anchor.tip,
    newGeneration: row.seq,
    newTip: row.tip,
    requestId: `recovery-${row.seq}-${row.tip.slice(0, 20)}`,
  });
  if (!response.ok) return { action: "refused_after_cas", response };
  markAnchored(databasePath, row.seq);
  return { action: "finalized_unacknowledged_successor", response };
}

async function advance(databasePath, socketPath, label) {
  const entry = appendCommitted(databasePath, label);
  const response = await anchorRequest(socketPath, {
    op: "cas",
    expectedGeneration: entry.sequence - 1,
    expectedTip: entry.previousTip,
    newGeneration: entry.sequence,
    newTip: entry.tip,
    requestId: `advance-${entry.sequence}-${entry.tip.slice(0, 20)}`,
  });
  if (!response.ok) throw new Error(`advance CAS failed: ${JSON.stringify(response)}`);
  markAnchored(databasePath, entry.sequence);
  return { entry, response };
}

function copyDatabase(databasePath, target) {
  checkpoint(databasePath);
  copyFileSync(databasePath, target);
  chmodSync(target, 0o600);
}

function restoreDatabase(snapshot, databasePath) {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  copyFileSync(snapshot, databasePath);
  chmodSync(databasePath, 0o600);
}

async function crashWorker(mode, databasePath, socketPath, label) {
  const child = spawn(node, [join(source, "ledger-crash-worker.mjs"), mode, databasePath, socketPath, label], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "" },
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const exit = await waitForExit(child);
  return { ...exit, stderr: stderr.join("") };
}

const results = {
  schema: "s3q-anchor-qualification/v1",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};

// Negative baseline: a well-written sibling file can be durable and mode-safe,
// but a copied old file remains a valid rollback.
const sibling = join(root, "plain-sibling");
mkdirSync(sibling, { mode: 0o700 });
const siblingPath = join(sibling, "anchor.json");
const siblingSnapshot = join(sibling, "anchor-genesis.snapshot");
durableWriteJson(siblingPath, { generation: 0, tip: GENESIS_TIP });
copyFileSync(siblingPath, siblingSnapshot);
durableWriteJson(siblingPath, { generation: 1, tip: createHash("sha256").update("plain-one").digest("hex") });
const beforeRollback = JSON.parse(readFileSync(siblingPath, "utf8"));
copyFileSync(siblingSnapshot, siblingPath);
const afterRollback = JSON.parse(readFileSync(siblingPath, "utf8"));
results.plainSiblingFile = {
  beforeRollback,
  afterRollback,
  staleSnapshotAcceptedAsWellFormed: afterRollback.generation === 0,
  metadata: statSummary(siblingPath),
  conclusion: "Durable local write and 0600 mode do not make a sibling file non-rollbackable.",
};

// CAS protocol and persistence qualification through a mock authority.
const casDirectory = join(root, "cas-authority");
let casAuthority = await startAuthority(casDirectory);
copyFileSync(casAuthority.statePath, join(casDirectory, "genesis.snapshot"));
const attempts = Array.from({ length: 24 }, (_, index) => {
  const newTip = createHash("sha256").update(`concurrent-${index}`).digest("hex");
  return anchorRequest(casAuthority.socketPath, {
    op: "cas",
    expectedGeneration: 0,
    expectedTip: GENESIS_TIP,
    newGeneration: 1,
    newTip,
    requestId: `concurrent-${index}`,
  }).then((response) => ({ index, newTip, response }));
});
const concurrent = await Promise.all(attempts);
const winners = concurrent.filter(({ response }) => response.ok && response.applied);
const winner = winners[0];
const stale = await anchorRequest(casAuthority.socketPath, {
  op: "cas", expectedGeneration: 0, expectedTip: GENESIS_TIP,
  newGeneration: 1, newTip: createHash("sha256").update("stale").digest("hex"), requestId: "stale-after-winner",
});
const replay = await anchorRequest(casAuthority.socketPath, {
  op: "cas", expectedGeneration: 0, expectedTip: GENESIS_TIP,
  newGeneration: 1, newTip: winner.newTip, requestId: `concurrent-${winner.index}`,
});
const stateMetadata = statSummary(casAuthority.statePath);
const socketMetadata = statSummary(casAuthority.socketPath);
const killed = await stopAuthority(casAuthority, "SIGKILL");
casAuthority = await startAuthority(casDirectory);
const afterRestart = await anchorRequest(casAuthority.socketPath, { op: "read" });
await stopAuthority(casAuthority);
copyFileSync(join(casDirectory, "genesis.snapshot"), join(casDirectory, "anchor-state.json"));
casAuthority = await startAuthority(casDirectory);
const afterLocalAuthorityRollback = await anchorRequest(casAuthority.socketPath, { op: "read" });
await stopAuthority(casAuthority);
results.mockAuthorityCas = {
  attempts: concurrent.length,
  appliedWinners: winners.length,
  compareFailures: concurrent.filter(({ response }) => response.code === "compare_failed").length,
  stale,
  idempotentReplay: replay,
  killed,
  afterRestart,
  stateMetadata,
  socketMetadata,
  afterLocalAuthorityRollback,
  localStateRollbackSucceeded: afterLocalAuthorityRollback.generation === 0,
  conclusion: "Protocol semantics pass; the mock's same-UID local state is intentionally not a trust anchor.",
};

// SQLite ledger plus the mock external-CAS protocol, including crash windows.
const integrationDirectory = join(root, "ledger-integration");
mkdirSync(integrationDirectory, { mode: 0o700 });
const databasePath = join(integrationDirectory, "ledger.sqlite");
let integrationAuthority = await startAuthority(join(integrationDirectory, "authority"));
const initialDatabase = openLedger(databasePath);
initialDatabase.close();
const first = await advance(databasePath, integrationAuthority.socketPath, "one");
copyDatabase(databasePath, join(integrationDirectory, "db-generation-1.snapshot"));
const authorityRestartExit = await stopAuthority(integrationAuthority, "SIGKILL");
integrationAuthority = await startAuthority(join(integrationDirectory, "authority"));
const authorityAfterRestart = await anchorRequest(integrationAuthority.socketPath, { op: "read" });
const second = await advance(databasePath, integrationAuthority.socketPath, "two");
copyDatabase(databasePath, join(integrationDirectory, "db-generation-2.snapshot"));

restoreDatabase(join(integrationDirectory, "db-generation-1.snapshot"), databasePath);
const staleRollbackAssessment = await assess(databasePath, integrationAuthority.socketPath);
restoreDatabase(join(integrationDirectory, "db-generation-2.snapshot"), databasePath);
deleteTail(databasePath);
const tailDeletionAssessment = await assess(databasePath, integrationAuthority.socketPath);
restoreDatabase(join(integrationDirectory, "db-generation-2.snapshot"), databasePath);

const beforeCommitCrash = await crashWorker("before-db-commit", databasePath, integrationAuthority.socketPath, "before-commit");
const afterBeforeCommitCrash = await assess(databasePath, integrationAuthority.socketPath);
const commitBeforeAnchorCrash = await crashWorker("after-db-commit-before-anchor", databasePath, integrationAuthority.socketPath, "commit-before-anchor");
const pendingAfterCrash = await assess(databasePath, integrationAuthority.socketPath);
const pendingRecovery = await finalizePending(databasePath, integrationAuthority.socketPath, pendingAfterCrash);
const afterPendingRecovery = await assess(databasePath, integrationAuthority.socketPath);
const anchorBeforeMarkCrash = await crashWorker("after-anchor-before-mark", databasePath, integrationAuthority.socketPath, "anchor-before-mark");
const responseLossAssessment = await assess(databasePath, integrationAuthority.socketPath);
const responseLossRecovery = await finalizePending(databasePath, integrationAuthority.socketPath, responseLossAssessment);
const afterResponseLossRecovery = await assess(databasePath, integrationAuthority.socketPath);

copyDatabase(databasePath, join(integrationDirectory, "db-before-paired-rollback.snapshot"));
copyFileSync(integrationAuthority.statePath, join(integrationDirectory, "anchor-before-paired-rollback.snapshot"));
await advance(databasePath, integrationAuthority.socketPath, "paired-rollback-newer");
const beforePairedRollback = await assess(databasePath, integrationAuthority.socketPath);
await stopAuthority(integrationAuthority);
restoreDatabase(join(integrationDirectory, "db-before-paired-rollback.snapshot"), databasePath);
copyFileSync(join(integrationDirectory, "anchor-before-paired-rollback.snapshot"), integrationAuthority.statePath);
integrationAuthority = await startAuthority(join(integrationDirectory, "authority"));
const afterPairedRollback = await assess(databasePath, integrationAuthority.socketPath);
const finalStateMetadata = statSummary(integrationAuthority.statePath);
const databaseMetadata = statSummary(databasePath);
await stopAuthority(integrationAuthority);

results.ledgerIntegration = {
  first,
  authorityRestartExit,
  authorityAfterRestart,
  second,
  staleRollbackClassification: staleRollbackAssessment.classification,
  tailDeletionClassification: tailDeletionAssessment.classification,
  beforeCommitCrash,
  afterBeforeCommitCrash: {
    classification: afterBeforeCommitCrash.classification,
    generation: afterBeforeCommitCrash.ledger.generation,
  },
  commitBeforeAnchorCrash,
  pendingAfterCrash: {
    classification: pendingAfterCrash.classification,
    databaseGeneration: pendingAfterCrash.ledger.generation,
    anchorGeneration: pendingAfterCrash.anchor.generation,
  },
  pendingRecovery,
  afterPendingRecovery: {
    classification: afterPendingRecovery.classification,
    unanchoredSequences: afterPendingRecovery.ledger.unanchoredSequences,
  },
  anchorBeforeMarkCrash,
  responseLossAssessment: {
    classification: responseLossAssessment.classification,
    unanchoredSequences: responseLossAssessment.ledger.unanchoredSequences,
  },
  responseLossRecovery,
  afterResponseLossRecovery: {
    classification: afterResponseLossRecovery.classification,
    unanchoredSequences: afterResponseLossRecovery.ledger.unanchoredSequences,
  },
  beforePairedRollback: {
    classification: beforePairedRollback.classification,
    generation: beforePairedRollback.ledger.generation,
  },
  afterPairedRollback: {
    classification: afterPairedRollback.classification,
    generation: afterPairedRollback.ledger.generation,
  },
  pairedRollbackAcceptedByLocalMock: afterPairedRollback.classification === "consistent" &&
    afterPairedRollback.ledger.generation < beforePairedRollback.ledger.generation,
  databaseMetadata,
  authorityStateMetadata: finalStateMetadata,
  caveat: "SIGKILL is a process-crash probe, not a power-loss or storage-controller durability test.",
};

console.log(JSON.stringify(results, null, 2));
