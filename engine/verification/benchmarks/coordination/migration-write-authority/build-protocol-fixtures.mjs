import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson, sha256 } from "../../../../src/kernel/integrity.ts";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OUTPUT_PATH = resolve(dirname(SCRIPT_PATH), "fixtures/authority-protocol-fixtures.v2.json");
const H = Object.freeze({
  one: "1".repeat(64), two: "2".repeat(64), three: "3".repeat(64), four: "4".repeat(64),
  five: "5".repeat(64), six: "6".repeat(64), seven: "7".repeat(64), eight: "8".repeat(64),
  nine: "9".repeat(64), a: "a".repeat(64), b: "b".repeat(64), c: "c".repeat(64),
  d: "d".repeat(64), e: "e".repeat(64), f: "f".repeat(64),
});
const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";
const OPERATIONS = Object.freeze([
  "acquire", "reserve", "heartbeat", "checkpoint", "fence",
  "compare-and-commit", "release", "inspect", "recover",
]);

function requestId(index) {
  const digit = String(index + 1);
  return `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
}

const repository = Object.freeze({
  repositoryIdentity: H.one,
  commonDirectoryIdentity: H.two,
  objectStoreIdentity: H.three,
  objectFormat: "sha1",
});
const base = Object.freeze({
  commit: null,
  tree: null,
  index: H.four,
  candidate: H.five,
  configuration: H.six,
  policy: H.seven,
  capabilities: H.eight,
});
const parentIdentity = Object.freeze({
  device: "1", inode: "2", mode: 448, ownerUid: "1000", ownerGid: "1000", links: "2", kind: "directory",
});
const fileIdentity = Object.freeze({
  device: "1", inode: "3", mode: 384, ownerUid: "1000", ownerGid: "1000", links: "1", kind: "file",
});
const absent = Object.freeze({ kind: "absent", parentIdentity, entryName: "candidate.json" });
const file = Object.freeze({ kind: "file", identity: fileIdentity, byteLength: 128, sha256: H.nine });
const resource = Object.freeze({
  kind: "physical-path",
  resourceId: "path.candidate-json",
  access: "write",
  resolution: "resolved",
  registryIdentity: H.a,
  normalizerIdentity: H.b,
  aliasClosure: ["path.candidate-json"],
  path: "candidate.json",
  portableCollisionKey: "candidate.json",
  observedState: absent,
});
const actor = Object.freeze({
  actorId: "agent.author",
  taskId: "architecture.migration",
  subtaskId: "architecture.migration.files",
  attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  processIdentity: H.c,
});

function leaseEvidence(state, generation = "1", fenceIdentity = H.d) {
  return {
    leaseId: LEASE_ID,
    generation,
    fenceIdentity,
    state,
    receiptAuthority: "evidence-only-never-authority",
  };
}

function commonRequest(operation, index) {
  return {
    schemaVersion: "migration-authority-message/v2",
    messageKind: "request",
    operation,
    requestId: requestId(index),
    idempotencyKey: H.e,
    repository,
  };
}

function authorizedRequest(operation, index, state = "active", generation = "1", fenceIdentity = H.d) {
  return {
    ...commonRequest(operation, index),
    authorityContext: "process-private-live-grant-required-out-of-band",
    leaseEvidence: leaseEvidence(state, generation, fenceIdentity),
  };
}

const requests = Object.freeze({
  acquire: {
    ...commonRequest("acquire", 0), actor, planIdentity: H.f, base,
    resourceRegistryIdentity: H.a, requestedTtlMs: 30_000, resources: [resource],
  },
  reserve: { ...authorizedRequest("reserve", 1), completeResourceUnion: [resource] },
  heartbeat: { ...authorizedRequest("heartbeat", 2), requestedTtlMs: 30_000, clockObservationIdentity: H.f },
  checkpoint: {
    ...authorizedRequest("checkpoint", 3), completedEffectIdentities: [],
    remainingWriteResourceIds: ["path.candidate-json"], nextSafeAction: "fence-next-effect", journalCursor: H.one,
  },
  fence: {
    ...authorizedRequest("fence", 4), effectId: EFFECT_ID, effectKind: "filesystem-create",
    resourceId: "path.candidate-json", expectedState: absent, intendedState: file, base, journalCursor: H.one,
  },
  "compare-and-commit": {
    ...authorizedRequest("compare-and-commit", 5, "fenced"), effectId: EFFECT_ID, fenceIdentity: H.d,
    resourceId: "path.candidate-json", base, expectedState: absent, intendedState: file,
    observedState: file, effectResultIdentity: H.f, journalCursor: H.two,
  },
  release: { ...authorizedRequest("release", 6), disposition: "completed", journalCursor: H.three },
  inspect: { ...commonRequest("inspect", 7), leaseId: LEASE_ID },
  recover: {
    ...authorizedRequest("recover", 8, "blocked-unknown-effect", "7", H.c),
    journalIdentity: H.f, observationIdentity: H.e, directionPreference: "next",
    recoveryFence: {
      generation: "8", fenceIdentity: H.d, supersedesGeneration: "7", supersedesFenceIdentity: H.c,
    },
  },
});

const resultStates = Object.freeze({
  acquire: "active", reserve: "active", heartbeat: "active", checkpoint: "active", fence: "fenced",
  "compare-and-commit": "active", release: "released", inspect: "active", recover: "reconciling",
});

function resultFor(operation, index) {
  const state = resultStates[operation];
  const evidence = operation === "release" ? null : operation === "recover" ?
    leaseEvidence(state, "8", H.d) : operation === "fence" ?
      leaseEvidence(state, "1", H.d) : leaseEvidence(state);
  return {
    schemaVersion: "migration-authority-message/v2",
    messageKind: "result",
    requestId: requestId(index),
    operation,
    outcome: "accepted",
    state,
    leaseEvidence: evidence,
    journalCursor: operation === "acquire" ? journalOne.entryIdentity :
      operation === "fence" ? journalTwo.entryIdentity : H.three,
    receiptAuthority: "evidence-only-not-a-bearer-capability",
  };
}

function journalEntry(input) {
  const withoutIdentity = {
    schemaVersion: "migration-authority-message/v2",
    messageKind: "journal-entry",
    sequence: input.sequence,
    previousEntryIdentity: input.previousEntryIdentity,
    repositoryIdentity: H.one,
    leaseId: LEASE_ID,
    generation: input.generation,
    transition: input.transition,
    requestIdentity: input.requestIdentity,
    effectIdentity: input.effectIdentity,
    observedStateIdentity: input.observedStateIdentity,
    receiptAuthority: "evidence-only-not-a-bearer-capability",
  };
  return { ...withoutIdentity, entryIdentity: canonicalHash(withoutIdentity) };
}

const journalOne = journalEntry({
  sequence: "1", previousEntryIdentity: null, generation: "1", transition: "requested-active",
  requestIdentity: canonicalHash(requests.acquire), effectIdentity: null, observedStateIdentity: null,
});
requests.fence.journalCursor = journalOne.entryIdentity;
const journalTwo = journalEntry({
  sequence: "2", previousEntryIdentity: journalOne.entryIdentity, generation: "1", transition: "active-fenced",
  requestIdentity: canonicalHash(requests.fence),
  effectIdentity: canonicalHash({ effectId: EFFECT_ID, effectKind: "filesystem-create" }),
  observedStateIdentity: canonicalHash(file),
});
requests["compare-and-commit"].journalCursor = journalTwo.entryIdentity;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const invalid = [];
function mutant(name, baseline, mutate) {
  const message = clone(baseline);
  mutate(message);
  invalid.push({ name, message });
}
mutant("serialized-live-grant", requests.reserve, (value) => { value.grant = { token: "forbidden" }; });
mutant("recover-without-newer-generation", requests.recover, (value) => { value.recoveryFence.generation = "7"; });
mutant("recover-without-new-fence", requests.recover, (value) => { value.recoveryFence.fenceIdentity = H.c; });
mutant("release-result-remains-active", resultFor("release", 6), (value) => {
  value.state = "active";
  value.leaseEvidence = leaseEvidence("active");
});
mutant("acquire-result-is-released", resultFor("acquire", 0), (value) => {
  value.state = "released";
  value.leaseEvidence = leaseEvidence("released");
});
mutant("acquire-request-with-fabricated-released-evidence", requests.acquire, (value) => {
  value.authorityContext = "process-private-live-grant-required-out-of-band";
  value.leaseEvidence = leaseEvidence("released");
});
mutant("recover-result-with-null-evidence", resultFor("recover", 8), (value) => {
  value.leaseEvidence = null;
});
mutant("compare-and-commit-missing-resource", requests["compare-and-commit"], (value) => { delete value.resourceId; });
mutant("filesystem-create-states-reversed", requests.fence, (value) => {
  value.expectedState = file;
  value.intendedState = absent;
});
mutant("journal-entry-hash-forged", journalTwo, (value) => { value.entryIdentity = H.f; });
mutant("journal-predecessor-forged", journalTwo, (value) => { value.previousEntryIdentity = H.f; });
mutant("journal-transition-impossible-for-first-entry", journalOne, (value) => {
  value.transition = "reconciling-released";
  const withoutIdentity = clone(value);
  delete withoutIdentity.entryIdentity;
  value.entryIdentity = canonicalHash(withoutIdentity);
});
mutant("journal-sequence-not-contiguous", journalTwo, (value) => {
  value.sequence = "3";
  const withoutIdentity = clone(value);
  delete withoutIdentity.entryIdentity;
  value.entryIdentity = canonicalHash(withoutIdentity);
});

const output = {
  schemaVersion: "migration-authority-protocol-fixtures/v2",
  status: "generated-author-controls-unadmitted",
  generatedBy: {
    relativePath: "verification/benchmarks/coordination/migration-write-authority/build-protocol-fixtures.mjs",
    sha256: sha256(readFileSync(SCRIPT_PATH)),
  },
  valid: [
    ...OPERATIONS.map((operation) => ({ name: `request-${operation}`, message: requests[operation] })),
    ...OPERATIONS.map((operation, index) => ({ name: `result-${operation}`, message: resultFor(operation, index) })),
    { name: "journal-sequence-1", message: journalOne },
    { name: "journal-sequence-2", message: journalTwo },
  ],
  invalid,
};

writeFileSync(OUTPUT_PATH, `${canonicalJson(output)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${canonicalJson({ output: OUTPUT_PATH, sha256: sha256(readFileSync(OUTPUT_PATH)) })}\n`);
