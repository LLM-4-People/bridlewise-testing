/**
 * THE JOURNALED MULTI-FILE COMMIT, DRIVEN (`src/filesystem/journaled-commit.ts`).
 *
 * Claims: the files land together with their exact modes and no residue; a
 * failing `verify` (the copy-back's `harness check`) rolls every file back —
 * including removing a file the transaction created; a real CRASH (SIGKILL,
 * no `finally`) at every phase leaves a journal the next run's recovery
 * resolves (pending → rolled back, verified → committed); a target someone
 * else changed is never overwritten by a rollback; recovery refuses bytes it
 * cannot name; and a second transaction waits for the first's recovery.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { commitJournaled, journalPathFor, journalsUnder, recoverJournaledCommit } from "../../src/filesystem/journaled-commit.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** The journal name every arm uses (the owner derives its path). */
const JOURNAL = "transaction";
const PRIMITIVE = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "filesystem", "journaled-commit.ts")).href;

/** A root with one existing file (0644) and a place for a new one. */
function fixture(): Readonly<{ root: string; journal: string; existing: string; created: string }> {
  const root = createTempDir("journaled-commit-");
  writeFileSync(join(root, "a.txt"), "base a\n", { mode: 0o644 });
  return { root, journal: journalPathFor(root, JOURNAL), existing: join(root, "a.txt"), created: join(root, "sub", "b.txt") };
}

const FILES = [
  { path: "a.txt", bytes: Buffer.from("next a\n"), mode: 0o664 },
  { path: "sub/b.txt", bytes: Buffer.from("next b\n"), mode: 0o755 },
] as const;

/** Every FILE under `root`: the residue witness (a staged copy or a journal would show here). */
function names(root: string): readonly string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) => statSync(join(root, name)).isFile()).toSorted();
}

test("the files land together, with their exact modes, and nothing is left behind", () => {
  const { root, existing, created } = fixture();
  const phases: string[] = [];
  commitJournaled(root, JOURNAL, FILES, { onPhase: (phase) => phases.push(phase) });
  assert.equal(readFileSync(existing, "utf8"), "next a\n");
  assert.equal(readFileSync(created, "utf8"), "next b\n");
  assert.equal(statSync(existing).mode & 0o777, 0o664);
  assert.equal(statSync(created).mode & 0o777, 0o755);
  assert.deepEqual(phases, ["journal-written", "staged", "committed:a.txt", "committed:sub/b.txt", "verified"]);
  assert.deepEqual(names(root), ["a.txt", "sub/b.txt"], "no staged copy or journal survives");
});

test("a failing verify rolls every file back — the created one removed — and rethrows", () => {
  const { root, journal, existing, created } = fixture();
  assert.throws(() => commitJournaled(root, JOURNAL, FILES, { verify: () => { throw new Error("check failed"); } }), /check failed/u);
  assert.equal(readFileSync(existing, "utf8"), "base a\n");
  assert.equal(statSync(existing).mode & 0o777, 0o644, "the base keeps its own mode");
  assert.equal(existsSync(created), false);
  assert.equal(existsSync(journal), false);
  assert.deepEqual(names(root), ["a.txt"]);
});

test("a rollback restores the base's WHOLE permission word — setgid and sticky too, never only the rwx bits (WF-1b3b design LOW 7)", () => {
  const { root, existing } = fixture();
  chmodSync(existing, 0o3644);
  const word = statSync(existing).mode & 0o7777;
  assert.equal(word & 0o3000, 0o3000, "the fixture carries setgid and sticky");
  assert.throws(() => commitJournaled(root, JOURNAL, FILES, { verify: () => { throw new Error("check failed"); } }), /check failed/u);
  assert.equal(readFileSync(existing, "utf8"), "base a\n");
  assert.equal(statSync(existing).mode & 0o7777, word);
});

/** Runs the transaction in a child that SIGKILLs itself at `phase`: a crash with no `finally`. */
function crashAt(root: string, phase: string): void {
  const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `const { commitJournaled } = await import(${JSON.stringify(PRIMITIVE)});`,
    `const files = ${JSON.stringify(FILES.map((file) => ({ ...file, bytes: file.bytes.toString("utf8") })))}.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));`,
    `commitJournaled(${JSON.stringify(root)}, ${JSON.stringify(JOURNAL)}, files, { onPhase: (phase) => { if (phase === ${JSON.stringify(phase)}) process.kill(process.pid, "SIGKILL"); } });`,
  ].join("\n")], { encoding: "utf8" });
  assert.equal(crashed.signal, "SIGKILL", `${phase}: ${crashed.stderr}`);
}

test("a CRASH at any phase before `verified` leaves a journal the next run rolls back", () => {
  for (const phase of ["journal-written", "staged", "committed:a.txt", "committed:sub/b.txt"]) {
    const { root, journal, existing, created } = fixture();
    crashAt(root, phase);
    assert.equal(existsSync(journal), true, `${phase}: the crash left no journal`);
    assert.equal(recoverJournaledCommit(root, JOURNAL), "rolled-back", phase);
    assert.equal(readFileSync(existing, "utf8"), "base a\n", phase);
    assert.equal(existsSync(created), false, phase);
    assert.deepEqual(names(root), ["a.txt"], `${phase}: residue after recovery`);
    assert.equal(recoverJournaledCommit(root, JOURNAL), "none");
  }
});

test("a crash after `verified` is completed by recovery, not undone", () => {
  const { root, existing, created } = fixture();
  crashAt(root, "verified");
  assert.equal(recoverJournaledCommit(root, JOURNAL), "committed");
  assert.equal(readFileSync(existing, "utf8"), "next a\n");
  assert.equal(readFileSync(created, "utf8"), "next b\n");
  assert.deepEqual(names(root), ["a.txt", "sub/b.txt"]);
});

test("a second transaction waits for recovery, a concurrent edit is never rolled over, and unknown bytes refuse recovery", () => {
  const { root, existing } = fixture();
  crashAt(root, "committed:a.txt");
  assert.throws(() => commitJournaled(root, JOURNAL, FILES), /already exists/u);
  // Someone else wrote the target after the crash: recovery refuses to guess.
  writeFileSync(existing, "someone else\n");
  assert.throws(() => recoverJournaledCommit(root, JOURNAL), /neither its base nor its next/u);
  assert.equal(readFileSync(existing, "utf8"), "someone else\n");

  // An edit that lands while the transaction runs (before staging) is refused
  // and left alone by the rollback.
  const second = fixture();
  assert.throws(() => commitJournaled(second.root, JOURNAL, FILES, {
    onPhase: (phase) => { if (phase === "journal-written") writeFileSync(second.existing, "concurrent\n"); },
  }), /changed after the transaction was planned/u);
  assert.equal(readFileSync(second.existing, "utf8"), "concurrent\n");
  assert.equal(existsSync(second.journal), false);
});

test("a LIVE transaction is never recovered: a concurrent recovery answers in-progress and touches nothing; the owner completes", async () => {
  // wf1c-design H-1 / wf1c-correctness §4 (reproduced): a concurrent
  // candidate-checkout run recovered a copy-back whose `verify` was still
  // running, rolled it back, and the owner then reported success.
  const { root, journal, existing, created } = fixture();
  const inVerify = join(root, "in-verify");
  const go = join(root, "go");
  const owner = spawn(process.execPath, ["--input-type=module", "-e", [
    `import { existsSync, writeFileSync } from "node:fs";`,
    `const { commitJournaled } = await import(${JSON.stringify(PRIMITIVE)});`,
    `const files = ${JSON.stringify(FILES.map((file) => ({ ...file, bytes: file.bytes.toString("utf8") })))}.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));`,
    `const pause = new Int32Array(new SharedArrayBuffer(4));`,
    `commitJournaled(${JSON.stringify(root)}, ${JSON.stringify(JOURNAL)}, files, { verify: () => { writeFileSync(${JSON.stringify(inVerify)}, ""); while (!existsSync(${JSON.stringify(go)})) Atomics.wait(pause, 0, 0, 20); } });`,
  ].join("\n")], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  owner.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolveExit) => owner.once("exit", (code) => resolveExit(code)));
  let recovery: string;
  let journalKept: boolean;
  let existingDuring: string;
  try {
    for (let i = 0; i < 500 && !existsSync(inVerify); i += 1) await new Promise((wait) => setTimeout(wait, 20));
    assert.equal(existsSync(inVerify), true, `the owner never reached verify: ${stderr}`);
    recovery = recoverJournaledCommit(root, JOURNAL);
    journalKept = existsSync(journal);
    existingDuring = readFileSync(existing, "utf8");
  } finally {
    // Always release the owner, so a failing arm never hangs the suite.
    writeFileSync(go, "");
  }
  assert.equal(recovery, "in-progress");
  assert.equal(journalKept, true, "the live owner's journal was removed");
  assert.equal(existingDuring, "next a\n", "a live transaction's file was rolled back");
  assert.equal(await exited, 0, stderr);
  assert.equal(readFileSync(existing, "utf8"), "next a\n");
  assert.equal(readFileSync(created, "utf8"), "next b\n");
  assert.equal(existsSync(journal), false);
});

test("an owner whose transaction was recovered meanwhile is PREEMPTED — never a false success", () => {
  const { root, journal, existing } = fixture();
  assert.throws(() => commitJournaled(root, JOURNAL, FILES, {
    // What a concurrent recovery would leave: the journal gone, the base back.
    verify: () => { rmSync(journal); writeFileSync(existing, "base a\n"); },
  }), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_preempted");
  assert.equal(readFileSync(existing, "utf8"), "base a\n");
});

test("a garbled journal is a typed refusal naming it, not a raw SyntaxError", () => {
  const { root, journal } = fixture();
  crashAt(root, "journal-written");
  writeFileSync(journal, "{ \"half\": ");
  assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) =>
    (error as { code?: unknown }).code === "journaled_commit_journal_unreadable" && String((error as Error).message).includes(journal));
});

test("journalsUnder: what `harness check` reports — an abandoned journal, a garbled one, none after recovery", () => {
  const { root, journal } = fixture();
  assert.deepEqual(journalsUnder(root), []);
  crashAt(root, "staged");
  assert.deepEqual(journalsUnder(root), [{ name: JOURNAL, state: "abandoned" }]);
  const saved = readFileSync(journal, "utf8");
  writeFileSync(journal, "garbled");
  assert.deepEqual(journalsUnder(root), [{ name: JOURNAL, state: "unreadable" }]);
  writeFileSync(journal, saved);
  assert.equal(recoverJournaledCommit(root, JOURNAL), "rolled-back");
  assert.deepEqual(journalsUnder(root), []);
});

test("the journal is published COMPLETE: a write that fails part-way (a file-size limit) leaves no journal and no residue, and a retry succeeds", () => {
  // wf1b-correctness §3: the journal was created in place and filled after,
  // so a full disk (or a crash between open and write) left a 0-byte journal
  // that blocked every later run until removed by hand, and a concurrent
  // reader of a HEALTHY transaction saw it `unreadable`.
  const { root, journal, existing } = fixture();
  const long = `deep/${"n".repeat(180)}`;
  const files = [
    { path: `${long}/one.txt`, bytes: "one\n", mode: 0o644 },
    { path: `${long}/two.txt`, bytes: "two\n", mode: 0o644 },
    { path: `${long}/three.txt`, bytes: "three\n", mode: 0o644 },
  ];
  // RLIMIT_FSIZE of one 512-byte block, SIGXFSZ ignored: the journal's write fails with EFBIG part-way.
  const limited = spawnSync("sh", ["-c", `trap '' XFSZ; ulimit -f 1; exec "$0" --input-type=module -e "$1"`, process.execPath, [
    `const { commitJournaled } = await import(${JSON.stringify(PRIMITIVE)});`,
    `const files = ${JSON.stringify(files)}.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));`,
    `try { commitJournaled(${JSON.stringify(root)}, ${JSON.stringify(JOURNAL)}, files); process.exit(0); } catch (error) { process.stderr.write(String(error.message)); process.exit(3); }`,
  ].join("\n")], { encoding: "utf8" });
  assert.equal(limited.status, 3, `the limited write did not fail as planned: ${limited.stderr}`);
  assert.equal(existsSync(journal), false, "a failed journal write left a journal behind");
  assert.deepEqual(journalsUnder(root), []);
  assert.deepEqual(names(root), ["a.txt"], "a failed journal write left residue");
  assert.equal(readFileSync(existing, "utf8"), "base a\n");
  commitJournaled(root, JOURNAL, files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) })));
  assert.equal(readFileSync(join(root, long, "three.txt"), "utf8"), "three\n");
});

test("recovery is ALL OR NOTHING: a missing or wrong backup refuses the whole rollback, typed, with every file left as it was", () => {
  for (const damage of ["missing", "wrong"] as const) {
    const { root, journal, existing, created } = fixture();
    crashAt(root, "committed:sub/b.txt");
    const record = JSON.parse(readFileSync(journal, "utf8")) as { files: Array<{ path: string; previousPath: string | null }> };
    const backup = join(root, record.files.find((file) => file.path === "a.txt")!.previousPath!);
    if (damage === "missing") rmSync(backup);
    else writeFileSync(backup, "not the base\n");
    assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_backup_invalid", damage);
    assert.equal(readFileSync(existing, "utf8"), "next a\n", `${damage}: a file was rolled back before the bad backup refused`);
    assert.equal(readFileSync(created, "utf8"), "next b\n", `${damage}: the created file was removed before the bad backup refused (a MIXED tree)`);
    assert.equal(existsSync(journal), true, `${damage}: the journal must be kept for a person`);
  }
});

test("a journal that does not describe its own transaction is unreadable (typed) and never acted on: a flipped digest, a staged name pointing elsewhere", () => {
  const { root, journal } = fixture();
  crashAt(root, "staged");
  const saved = readFileSync(journal, "utf8");
  const victim = join(root, "victim.txt");
  writeFileSync(victim, "an unrelated file\n");
  const record = JSON.parse(saved) as { files: Array<{ baseSha256: string | null; nextPath: string }> };
  // A digest flip that stays schema-valid (hex for hex).
  const flipped = structuredClone(record);
  flipped.files[0]!.baseSha256 = `${flipped.files[0]!.baseSha256!.startsWith("0") ? "1" : "0"}${flipped.files[0]!.baseSha256!.slice(1)}`;
  const elsewhere = structuredClone(record);
  elsewhere.files[0]!.nextPath = "victim.txt";
  for (const garbled of [flipped, elsewhere]) {
    writeFileSync(journal, JSON.stringify(garbled));
    const before = names(root).map((name) => `${name}:${readFileSync(join(root, name), "utf8")}`);
    assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_journal_unreadable");
    assert.deepEqual(names(root).map((name) => `${name}:${readFileSync(join(root, name), "utf8")}`), before, "a garbled journal was acted on");
  }
  assert.equal(readFileSync(victim, "utf8"), "an unrelated file\n");
  writeFileSync(journal, saved);
  assert.equal(recoverJournaledCommit(root, JOURNAL), "rolled-back");
});

test("the transaction id covers the OWNER: a garbled owner is unreadable (never `in-progress` forever), and a retry by another process has its own staged names (wf1b2-correctness §4.3)", () => {
  const { root, journal } = fixture();
  crashAt(root, "staged");
  const saved = readFileSync(journal, "utf8");
  const record = JSON.parse(saved) as { transactionId: string; owner: { pid: number; startTime: number | null } };
  writeFileSync(journal, JSON.stringify({ ...record, owner: { pid: 1, startTime: null } }));
  assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_journal_unreadable");
  assert.deepEqual(journalsUnder(root), [{ name: JOURNAL, state: "unreadable" }], "a garbled owner hid a mixed tree behind `in-progress`");
  writeFileSync(journal, saved);
  assert.equal(recoverJournaledCommit(root, JOURNAL), "rolled-back");
  // The same plan by THIS process: another owner, another transaction id, so none of the abandoned attempt's staged names.
  const phases: string[] = [];
  let retryId = "";
  commitJournaled(root, JOURNAL, FILES, { onPhase: (phase) => { phases.push(phase); if (phase === "journal-written") retryId = (JSON.parse(readFileSync(journal, "utf8")) as { transactionId: string }).transactionId; } });
  assert.notEqual(retryId, record.transactionId, "a retry of the same plan reused the abandoned attempt's id (and staged names)");
});

test("a `verified` journal is trusted only when every target holds its next bytes: otherwise a typed refusal that keeps every staged copy", () => {
  const { root, journal, existing } = fixture();
  crashAt(root, "committed:a.txt");
  // The one-field garble (or a lost rename after a power cut): pending → verified with sub/b.txt never renamed.
  const record = JSON.parse(readFileSync(journal, "utf8")) as Record<string, unknown>;
  writeFileSync(journal, JSON.stringify({ ...record, state: "verified" }));
  const before = names(root);
  assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_verified_mismatch");
  assert.deepEqual(names(root), before, "a staged copy was deleted on an unverified `verified`");
  assert.equal(readFileSync(existing, "utf8"), "next a\n");
});

test("an unreadable backup or target is a TYPED refusal (never a raw EISDIR), and a rollback restores the RECORDED base mode, never the backup's (a planted setuid copy)", () => {
  {
    const { root, journal, existing } = fixture();
    crashAt(root, "committed:sub/b.txt");
    const record = JSON.parse(readFileSync(journal, "utf8")) as { files: Array<{ path: string; previousPath: string | null }> };
    const backup = join(root, record.files.find((file) => file.path === "a.txt")!.previousPath!);
    rmSync(backup);
    mkdirSync(backup);
    assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_backup_invalid");
    assert.equal(readFileSync(existing, "utf8"), "next a\n");
  }
  {
    const { root, existing } = fixture();
    crashAt(root, "committed:sub/b.txt");
    rmSync(join(root, "sub", "b.txt"));
    mkdirSync(join(root, "sub", "b.txt"));
    assert.throws(() => recoverJournaledCommit(root, JOURNAL), (error: unknown) => (error as { code?: unknown }).code === "journaled_commit_target_unreadable");
    assert.equal(readFileSync(existing, "utf8"), "next a\n");
  }
  {
    const { root, journal, existing } = fixture();
    crashAt(root, "committed:sub/b.txt");
    const record = JSON.parse(readFileSync(journal, "utf8")) as { files: Array<{ path: string; previousPath: string | null }> };
    chmodSync(join(root, record.files.find((file) => file.path === "a.txt")!.previousPath!), 0o6777);
    assert.equal(recoverJournaledCommit(root, JOURNAL), "rolled-back");
    assert.equal(statSync(existing).mode & 0o7777, 0o644, "the rollback restored the backup's setuid mode");
  }
});

test("CONCURRENT recoverers take turns: every one answers rolled-back or none (never a false backup_invalid), and the tree ends at its base", async () => {
  for (let round = 0; round < 3; round += 1) {
    const { root, existing, created } = fixture();
    crashAt(root, "committed:sub/b.txt");
    const recoverer = (): Promise<string> => new Promise((resolveAnswer) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", [
        `const { recoverJournaledCommit } = await import(${JSON.stringify(PRIMITIVE)});`,
        `try { process.stdout.write(recoverJournaledCommit(${JSON.stringify(root)}, ${JSON.stringify(JOURNAL)})); } catch (error) { process.stdout.write("ERR:" + String(error.code)); }`,
      ].join("\n")], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => { out += String(chunk); });
      child.on("close", () => resolveAnswer(out));
    });
    const answers = await Promise.all([recoverer(), recoverer(), recoverer(), recoverer()]);
    for (const answer of answers) assert.ok(answer === "rolled-back" || answer === "none", `a recoverer answered ${answer}`);
    assert.equal(answers.filter((answer) => answer === "rolled-back").length, 1, `exactly one recoverer rolls back: ${answers.join(", ")}`);
    assert.equal(readFileSync(existing, "utf8"), "base a\n");
    assert.equal(existsSync(created), false);
    assert.deepEqual(names(root), ["a.txt"], "residue after concurrent recovery (a lock or a staged copy)");
  }
});
