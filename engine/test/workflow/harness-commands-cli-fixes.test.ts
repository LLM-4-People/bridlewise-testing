import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  harnessMetrics,
  harnessRollback,
  harnessExtensionList,
  harnessSync,
  autoAddDispositionEntries,
  regeneratePinAuthorities,
  regenerateRatchetBaselines,
  regenerateTestInventory,
  runInventoryCheck,
  HARNESS_ROOT,
  HARNESS_SUBCOMMANDS,
  promotionsStep,
  runHarnessCli,
  type HarnessMetricsOutput,
  type HarnessRollbackOutput,
} from "../../src/workflow/harness-commands.ts";
import { generatorReport, runScriptSubprocess } from "../../src/workflow/script-subprocess.ts";
import { boundedEnding } from "../../src/process/subprocess-bounds.ts";
import { SUBPROCESS_BOUNDS } from "../../src/workflow/workflow-config.ts";
import { runBenchmarkCli, parseBenchmarkArgs } from "../../src/performance/benchmark-cli.ts";
import { runDiagnosticCli, parseDiagnosticArgs } from "../../src/performance/diagnostic-cli.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder, type TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { envelopeText, HARNESS_COMMAND_SCHEMA_VERSION, takeOutputFormat } from "../../src/workflow/command-result.ts";
import { walkTs } from "../../scripts/verification/source-walk.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// harness metrics
// ---------------------------------------------------------------------------

test("harnessMetrics: returns a valid snapshot structure (honest empty result, not not_yet_implemented)", () => {
  const result = harnessMetrics(ROOT);
  assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.equal(result.command, "metrics");
  assert.ok(["pass", "fail"].includes(result.status));
  const output = result.result as HarnessMetricsOutput;
  assert.ok(output.snapshot !== undefined);
  assert.equal(output.snapshot.schemaVersion, "bridlewise-metrics-snapshot/v1");
  assert.ok(typeof output.snapshot.snapshotId === "string");
  assert.ok(output.snapshot.snapshotId.startsWith("snap-"));
  assert.ok(typeof output.snapshot.entryCount === "number");
  assert.ok(typeof output.snapshot.totalCallCount === "number");
  assert.ok(typeof output.snapshot.totalErrorCount === "number");
  assert.ok(typeof output.snapshot.totalCancellationCount === "number");
  assert.ok(Array.isArray(output.snapshot.entries));
  assert.ok(Array.isArray(output.recentResourceEvents));
});

test("harnessMetrics: snapshot reports honest zero-state for fresh CLI invocation", () => {
  const result = harnessMetrics(ROOT);
  const output = result.result as HarnessMetricsOutput;
  // A fresh CLI invocation has no live collector data, so the in-process
  // snapshot reports zero entries. This is the honest empty result the
  // fix requires (replacing the prior not_yet_implemented stub).
  assert.equal(output.snapshot.entryCount, 0);
  assert.equal(output.snapshot.totalCallCount, 0);
  assert.equal(output.snapshot.entries.length, 0);
});

test("harnessMetrics: with injectable dbPath reads recent resource events from a temp timeline", () => {
  const dir = createTempDir("harness-metrics-test-");
  try {
    const dbPath = join(dir, "timeline.db");
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-metrics-test" });
    const recorder: TimelineRecorder = createTimelineRecorder({ store });
    recorder.recordResource({
      metric: "test.metric",
      value: 42,
      unit: "calls",
      correlation: { runId: "run-metrics-test" },
    });
    // recorder.close also closes the underlying store.
    recorder.close();

    const result = harnessMetrics(ROOT, { dbPath });
    const output = result.result as HarnessMetricsOutput;
    assert.ok(output.recentResourceEvents.length >= 1, "expected at least one resource event");
    const found = output.recentResourceEvents.find((e) => e.description.includes("test.metric"));
    assert.ok(found !== undefined, `expected to find test.metric event; got: ${output.recentResourceEvents.map((e) => e.description).join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harnessMetrics: with non-existent dbPath returns empty recentResourceEvents", () => {
  const dir = createTempDir("harness-metrics-empty-");
  try {
    const dbPath = join(dir, "does-not-exist.db");
    const result = harnessMetrics(ROOT, { dbPath });
    const output = result.result as HarnessMetricsOutput;
    assert.equal(output.recentResourceEvents.length, 0);
    assert.equal(output.snapshot.entryCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harnessMetrics: result is frozen and integrity hash is valid", () => {
  const result = harnessMetrics(ROOT);
  assert.ok(Object.isFrozen(result));
  assert.ok(typeof result.integrityHash === "string");
  assert.equal(result.integrityHash.length, 64);
});

// ---------------------------------------------------------------------------
// harness rollback
// ---------------------------------------------------------------------------

test("harnessRollback: with non-existent dbPath returns empty result", () => {
  const dir = createTempDir("harness-rollback-missing-");
  try {
    const dbPath = join(dir, "does-not-exist.db");
    const result = harnessRollback(ROOT, {}, { dbPath });
    assert.equal(result.command, "rollback");
    const output = result.result as HarnessRollbackOutput;
    assert.equal(output.effectId, null);
    assert.equal(output.result, null);
    assert.equal(output.recentEffects.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harnessRollback: without effect-id lists recent file-effect events from a temp timeline", () => {
  const dir = createTempDir("harness-rollback-list-");
  try {
    const dbPath = join(dir, "timeline.db");
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-rb-list" });
    const recorder = createTimelineRecorder({ store });
    recorder.recordFileEffect({
      effectId: "fx-test-1",
      path: "test/file.txt",
      operation: "write",
      preimageDigest: "a".repeat(64),
      postimageDigest: "b".repeat(64),
      description: "Test file write for rollback listing",
      correlation: { runId: "run-rb-list" },
    });
    // recorder.close also closes the underlying store, so don't double-close.
    recorder.close();

    const result = harnessRollback(ROOT, {}, { dbPath });
    assert.equal(result.command, "rollback");
    assert.equal(result.status, "pass");
    const output = result.result as HarnessRollbackOutput;
    assert.equal(output.effectId, null);
    assert.equal(output.result, null);
    assert.ok(output.recentEffects.length >= 1, "expected at least one file-effect event");
    // recordFileEffect stores the effectId in the eventId (file-fx-test--...),
    // not in the effect_id column (which is NULL for appendEvent records).
    const found = output.recentEffects.find((e) => e.description === "Test file write for rollback listing");
    assert.ok(found !== undefined, "expected to find the test file-effect event by description");
    assert.equal(found!.ledgerId, "ledger-rb-list");
    assert.ok(found!.eventId.startsWith("file-fx-test-1-"), `eventId should start with file-fx-test-1-; got ${found!.eventId}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harnessRollback: with non-existent effect-id throws rollback_effect_not_found", () => {
  const dir = createTempDir("harness-rollback-notfound-");
  try {
    const dbPath = join(dir, "timeline.db");
    // Create the DB with at least one event so the DB exists
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-rb-nf" });
    const recorder = createTimelineRecorder({ store });
    recorder.recordRun({ description: "test run", correlation: { runId: "run-nf" } });
    // recorder.close also closes the underlying store.
    recorder.close();

    assert.throws(
      () => harnessRollback(ROOT, { effectId: "fx-nonexistent" }, { dbPath }),
      (err: unknown) => err instanceof InputError && (err as InputError).code === "rollback_effect_not_found",
      "expected rollback_effect_not_found InputError",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harnessRollback: with injectable dbPath reads recent effects", () => {
  const dir = createTempDir("harness-rollback-inject-");
  try {
    const dbPath = join(dir, "timeline.db");
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-inject" });
    const recorder = createTimelineRecorder({ store });
    recorder.recordFileEffect({
      effectId: "fx-inject-1",
      path: "src/test.ts",
      operation: "write",
      preimageDigest: "c".repeat(64),
      postimageDigest: "d".repeat(64),
      description: "Injected file effect for rollback test",
      correlation: { runId: "run-inject" },
    });
    // recorder.close also closes the underlying store.
    recorder.close();

    const result = harnessRollback(ROOT, {}, { dbPath });
    const output = result.result as HarnessRollbackOutput;
    assert.ok(output.recentEffects.length >= 1);
    const found = output.recentEffects.find((e) => e.description === "Injected file effect for rollback test");
    assert.ok(found !== undefined);
    assert.equal(found!.description, "Injected file effect for rollback test");
    assert.ok(found!.eventId.startsWith("file-fx-inject-1-"), `eventId should start with file-fx-inject-1-; got ${found!.eventId}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("harnessRollback: result is frozen and integrity hash is valid", () => {
  const dir = createTempDir("harness-rollback-frozen-");
  try {
    const dbPath = join(dir, "timeline.db");
    const store = createTimelineStore({ path: dbPath, ledgerId: "ledger-frozen" });
    store.close();
    const result = harnessRollback(ROOT, {}, { dbPath });
    assert.ok(Object.isFrozen(result));
    assert.ok(typeof result.integrityHash === "string");
    assert.equal(result.integrityHash.length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// harness extension list
// ---------------------------------------------------------------------------

test("harnessExtensionList: returns a valid snapshot of the in-memory manifest", () => {
  const result = harnessExtensionList();
  assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.equal(result.command, "extension");
  assert.ok(["pass", "fail"].includes(result.status));
  assert.ok(typeof result.result.total === "number");
  assert.ok(Array.isArray(result.result.extensions));
  // The manifest is in-memory and empty at CLI start (extensions are registered
  // through the lifecycle/approval workflow, not through the CLI).
  assert.equal(result.result.total, 0);
  assert.equal(result.result.extensions.length, 0);
});

test("harnessExtensionList: result is frozen and integrity hash is valid", () => {
  const result = harnessExtensionList();
  assert.ok(Object.isFrozen(result));
  assert.ok(typeof result.integrityHash === "string");
  assert.equal(result.integrityHash.length, 64);
});

// ---------------------------------------------------------------------------
// harness benchmark / diagnostic CLI (FIX 7)
// ---------------------------------------------------------------------------

function captureStdout(fn: () => Promise<number> | number): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  return Promise.resolve(fn()).then(
    (exitCode) => { process.stdout.write = original; return { stdout, exitCode }; },
    (error) => { process.stdout.write = original; throw error; },
  );
}

test("harness benchmark and diagnostic subcommands are registered (FIX 7)", () => {
  assert.ok(HARNESS_SUBCOMMANDS.includes("benchmark"), "benchmark subcommand must be registered");
  assert.ok(HARNESS_SUBCOMMANDS.includes("diagnostic"), "diagnostic subcommand must be registered");
});

test("harness benchmark: parseBenchmarkArgs parses --repetitions; the output format is never a verb's flag (FIX 7)", () => {
  assert.equal(parseBenchmarkArgs([]).repetitions, null);
  assert.equal(parseBenchmarkArgs(["--repetitions", "5"]).repetitions, 5);
  assert.throws(() => parseBenchmarkArgs(["--repetitions", "0"]), /positive integer/u);
  assert.throws(() => parseBenchmarkArgs(["--unknown"]), /unknown benchmark flag/u);
  assert.throws(() => parseBenchmarkArgs(["--json"]), /unknown benchmark flag/u);
});

test("harness diagnostic: parseDiagnosticArgs parses --mode; the output format is never a verb's flag (FIX 7)", () => {
  assert.equal(parseDiagnosticArgs([]).mode, null);
  assert.equal(parseDiagnosticArgs(["--mode", "cpu"]).mode, "cpu");
  assert.throws(() => parseDiagnosticArgs(["--mode", "invalid"]), /--mode must be one of/u);
  assert.throws(() => parseDiagnosticArgs(["--unknown"]), /unknown diagnostic flag/u);
  assert.throws(() => parseDiagnosticArgs(["--text"]), /unknown diagnostic flag/u);
});

test("harness benchmark: real benchmark results, in the harness envelope (--json, the default) and as the table (--text) (FIX 7)", async () => {
  const { stdout, exitCode } = await captureStdout(() => runHarnessCli(["benchmark", "--repetitions", "3", "--json"]));
  assert.equal(exitCode, 0, `benchmark CLI must exit 0; stdout=${stdout.slice(0, 500)}`);
  const envelope = JSON.parse(stdout) as { command: string; status: string; result: {
    schemaVersion: string;
    hardwareFingerprint: { fingerprintHash: string };
    results: ReadonlyArray<{ benchmarkName: string; totalRepetitions: number; failedRepetitions: number }>;
  } };
  assert.deepEqual([envelope.command, envelope.status], ["benchmark", "pass"]);
  const report = envelope.result;
  assert.equal(report.schemaVersion, "bridlewise-benchmark-cli/v1");
  assert.ok(report.hardwareFingerprint.fingerprintHash.length === 64);
  assert.ok(report.results.length >= 1, "benchmark CLI must run at least one target");
  for (const result of report.results) {
    assert.ok(result.benchmarkName.length > 0);
    assert.ok(result.totalRepetitions > 0);
    assert.equal(result.failedRepetitions, 0, `benchmark '${result.benchmarkName}' must not fail reps`);
  }
  const answer = await runBenchmarkCli(["--repetitions", "3"]);
  assert.match(answer.text!(), /^=== Harness Benchmark Results ===\n/u);
});

test("harness diagnostic: a real CPU snapshot, in the harness envelope (FIX 7)", () => {
  return captureStdout(() => runHarnessCli(["diagnostic", "--mode", "cpu"])).then(({ stdout, exitCode }) => {
    assert.equal(exitCode, 0, `diagnostic CLI must exit 0; stdout=${stdout.slice(0, 500)}`);
    const envelope = JSON.parse(stdout) as { command: string; result: {
      schemaVersion: string;
      supportedModes: readonly string[];
      results: ReadonlyArray<{
        mode: string;
        runId: string;
        durationMs: number;
        timedOut: boolean;
        snapshot: { mode: string; attribution: string };
      }>;
    } };
    assert.equal(envelope.command, "diagnostic");
    const report = envelope.result;
    assert.equal(report.schemaVersion, "bridlewise-diagnostic-cli/v1");
    assert.ok(report.supportedModes.length >= 1);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0]!.mode, "cpu");
    assert.equal(report.results[0]!.timedOut, false);
    assert.equal(report.results[0]!.snapshot.mode, "cpu");
    const answer = runDiagnosticCli(["--mode", "cpu"]);
    assert.match(answer.text!(), /^=== Harness Diagnostic Snapshot ===\n {2}cpu:/u);
  });
});

// ---------------------------------------------------------------------------
// ONE output option for every harness verb (--json, the default, or --text)
// ---------------------------------------------------------------------------

function captureBoth(fn: () => Promise<number>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let stderr = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  return captureStdout(fn).then(
    ({ stdout, exitCode }) => { process.stderr.write = original; return { stdout, stderr, exitCode }; },
    (error) => { process.stderr.write = original; throw error; },
  );
}

test("ONE output option: every verb answers the JSON envelope by default and with --json, and its report with --text, wherever the flag stands (the last wins)", async () => {
  const json = await captureBoth(() => runHarnessCli(["extension", "list"]));
  assert.equal(json.exitCode, 0);
  assert.equal((JSON.parse(json.stdout) as { schemaVersion: string }).schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.deepEqual(JSON.parse((await captureBoth(() => runHarnessCli(["--text", "extension", "list", "--json"]))).stdout).command, "extension");
  const text = await captureBoth(() => runHarnessCli(["extension", "--text", "list"]));
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout, /^extension: pass\n {2}extensions:/u);
  assert.match(text.stdout, /\n {2}total: \d+\n$/u);
  assert.equal(text.stdout.includes("{\""), false, "a report, not the envelope");
});

test("ONE output option: a refusal is rendered as asked too (stderr: the record as JSON, or `<code>: <message>`), and the exit code is the verb's", async () => {
  const json = await captureBoth(() => runHarnessCli(["metrics", "--bogus"]));
  assert.equal(json.exitCode, 1);
  assert.equal((JSON.parse(json.stderr) as { error: string }).error, "unknown_flag");
  const text = await captureBoth(() => runHarnessCli(["metrics", "--bogus", "--text"]));
  assert.equal(text.exitCode, 1);
  assert.match(text.stderr, /^unknown_flag: unknown metrics flag: --bogus \(no flags supported\)/u);
  const unknown = await captureBoth(() => runHarnessCli(["no-such-verb", "--text"]));
  assert.match(unknown.stderr, /^unknown_harness_subcommand: unknown harness subcommand: no-such-verb \(/u);
});

test("the generic report: `<command>: <status>`, then the result as indented key: value lines, lists as `- ` entries", () => {
  const envelope = { schemaVersion: HARNESS_COMMAND_SCHEMA_VERSION, command: "workspace validate", status: "fail", generatedAt: "t", integrityHash: "h",
    result: { action: "validate", report: { gates: [{ gate: "engine-suite", status: "fail", details: ["a new failure"] }, { gate: "web-suite", status: "skip", details: [] }], full: true } } } as const;
  assert.equal(envelopeText(envelope), [
    "workspace validate: fail",
    "  action: validate",
    "  report:",
    "    gates:",
    "      - gate: engine-suite",
    "        status: fail",
    "        details:",
    "          - a new failure",
    "      - gate: web-suite",
    "        status: skip",
    "        details: []",
    "    full: true",
    "",
  ].join("\n"));
  assert.deepEqual(takeOutputFormat(["a", "--json", "b", "--text"]), { format: "text", argv: ["a", "b"] });
  assert.deepEqual(takeOutputFormat(["a"]), { format: "json", argv: ["a"] });
  // After `--` every argument is an operand: a path named `--text` stays a path (WF-1b3c-FIX LOW-1).
  assert.deepEqual(takeOutputFormat(["declare", "--text", "--", "--json", "--text"]), { format: "text", argv: ["declare", "--", "--json", "--text"] });
});

test("no verb parses the output option itself: `--json` / `--text` are spelled in the one owner (command-result.ts) alone", () => {
  const offenders = walkTs(join(ROOT, "src")).filter((path) => !path.endsWith(join("src", "workflow", "command-result.ts")) &&
    /["']--(?:json|text)["']/u.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});

test("harness check's promotions step SAYS refs it cannot read (skipped, naming the failure) instead of crashing the whole check (PROMO34FIX-CHECK-STEP)", () => {
  const repo = createTempDir("check-promotions-unreadable-");
  execFileSync("git", ["init", "-q", repo], { env: { ...process.env, ...testGitIdentityEnvironment() } });
  assert.equal(promotionsStep(repo).status, "pass", "a healthy repository lists its promotions");
  // A packed-refs file git cannot read: `for-each-ref` fails.
  writeFileSync(join(repo, ".git", "packed-refs"), "not a packed ref line\n");
  const step = promotionsStep(repo);
  assert.equal(step.step, "promotions");
  assert.equal(step.status, "skip");
  assert.match(step.message, /^the promotions in flight could not be listed: /u);
});


// ---------------------------------------------------------------------------
// harness root resolution (the documented root invocation)
// ---------------------------------------------------------------------------

test("the harness root is the engine package, not the caller's cwd", () => {
  // The documented command runs from the REPOSITORY root, where the engine is
  // a subdirectory. The root every verb resolves its scripts against must be
  // the package that owns them.
  assert.equal(resolve(HARNESS_ROOT), resolve(ROOT));
  assert.ok(readFileSync(join(HARNESS_ROOT, "package.json"), "utf8").includes('"name": "bridlewise"'));
});

test("a builder script missing from the supplied root names the file and the root, not Node's version banner", () => {
  const dir = createTempDir("harness-missing-builder-");
  try {
    assert.throws(
      () => runScriptSubprocess(dir, "scripts/pin-authority-regeneration.ts", ["--check"]),
      (error: unknown) => {
        assert.ok(error instanceof InputError);
        assert.match(error.message, /does not contain scripts\/pin-authority-regeneration\.ts/u);
        assert.match(error.message, /resolved against/u);
        assert.ok(error.message.includes(dir), "the reported root is the one actually searched");
        assert.doesNotMatch(error.message, /Node\.js v/u);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the DOCUMENTED root invocation reaches the pin-authorities step instead of dying in the builder", () => {
  // `./bin/bridlewise.mjs harness check --skip-typecheck` from the repository
  // root is the README's command. Before the fix it died inside
  // `scripts/pin-authority-regeneration.ts` with an untyped subprocess
  // failure. The check may legitimately report drift in a developer tree (an
  // unbuilt bundle, an un-synced manifest); what this arm pins is that the
  // step RAN and was judged, with no death in the builder itself.
  const repositoryRoot = resolve(ROOT, "..");
  const result = spawnSync(
    process.execPath,
    [join(ROOT, "src", "cli.ts"), "harness", "check", "--skip-typecheck", "--skip-architecture", "--skip-inventory"],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 180_000 },
  );
  assert.equal(result.error, undefined, "the documented invocation must complete");
  assert.equal(typeof result.status, "number", "the process must exit, not be killed");
  assert.doesNotMatch(result.stderr ?? "", /without a status payload/u);
  const answer = JSON.parse(result.stdout) as { result?: { pinAuthorities?: { step?: string; status?: string } } };
  assert.equal(answer.result?.pinAuthorities?.step, "pin-authorities");
  assert.ok(["pass", "fail"].includes(String(answer.result?.pinAuthorities?.status)));
});

// ---------------------------------------------------------------------------
// A script subprocess is bounded in CPU work, never killed by a wall clock a
// loaded host runs out (NO-LOAD-BLOCK L2, audit A-18), and one that ends
// without a payload says HOW it ended (status, signal, which bound fired).
// ---------------------------------------------------------------------------

test("a script subprocess that dies without a payload names how it ended: the signal, or its exit status", () => {
  const dir = createTempDir("harness-subprocess-ending-");
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "signalled.ts"), "process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 10_000);\n");
    writeFileSync(join(dir, "scripts", "silent-exit.ts"), "process.exit(3);\n");
    assert.throws(() => runScriptSubprocess(dir, "scripts/signalled.ts", []), (error: unknown) => {
      assert.match((error as Error).message, /scripts\/signalled\.ts ended without a status payload: it was ended by signal SIGTERM/u);
      return true;
    });
    assert.throws(() => runScriptSubprocess(dir, "scripts/silent-exit.ts", []), (error: unknown) => {
      assert.match((error as Error).message, /it exited with status 3 \(it printed nothing on stderr\)/u);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the two L2 bounds are named when they fire: the CPU-time limit (SIGXCPU) and the hang backstop (HUNG)", () => {
  assert.match(boundedEnding({ status: null, signal: "SIGXCPU" }, SUBPROCESS_BOUNDS), /spent its CPU-time limit of 1800 s of CPU work \(RLIMIT_CPU\)/u);
  assert.match(boundedEnding({ status: null, signal: "SIGKILL", errorCode: "ETIMEDOUT" }, SUBPROCESS_BOUNDS), /^HUNG: it was still running at the 7200 s hang backstop \(wall\) and was killed with SIGKILL/u);
});

/** Each bound, driven THROUGH runScriptSubprocess with bounds small enough to fire. */
function boundedFixture(name: string, body: string): Readonly<{ dir: string; script: string }> {
  const dir = createTempDir(`harness-bound-${name}-`);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", `${name}.ts`), body);
  return { dir, script: `scripts/${name}.ts` };
}

test("BOUND 1, the CPU-time limit: a step past it is ended by SIGXCPU and says so", () => {
  const { dir, script } = boundedFixture("spin", "for (;;) {}\n");
  try {
    assert.throws(() => runScriptSubprocess(dir, script, [], { bounds: { cpuLimitSeconds: 1, cpuKillGraceSeconds: 5, hangBackstopMs: 120_000 } }), (error: unknown) => {
      assert.match((error as Error).message, /spent its CPU-time limit of 1 s of CPU work \(RLIMIT_CPU\) and was ended by SIGXCPU/u);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BOUND 1 is BINDING: the hard limit is set too, so no child can raise its CPU limit", () => {
  const { dir, script } = boundedFixture("limits", 'import { execFileSync } from "node:child_process";\nconst read = (flag: string) => execFileSync("/bin/sh", ["-c", `ulimit ${flag} -t`], { encoding: "utf8" }).trim();\nlet raised = "refused";\ntry { execFileSync("/bin/sh", ["-c", "ulimit -H -t unlimited"], { stdio: "ignore" }); raised = "raised"; } catch {}\nprocess.stdout.write(JSON.stringify({ soft: read("-S"), hard: read("-H"), raised }));\n');
  try {
    const ran = runScriptSubprocess(dir, script, [], { bounds: { cpuLimitSeconds: 7, cpuKillGraceSeconds: 3, hangBackstopMs: 120_000 } });
    assert.ok(ran.ok, "the limits probe exits clean");
    const answer = JSON.parse(ran.payload) as { soft: string; hard: string; raised: string };
    assert.deepEqual(answer, { soft: "7", hard: "10", raised: "refused" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("BOUND 2, the hang backstop: a step still running at it is killed and reported HUNG (script_subprocess_hung)", () => {
  const { dir, script } = boundedFixture("sleeps", "setTimeout(() => {}, 60_000);\n");
  try {
    assert.throws(() => runScriptSubprocess(dir, script, [], { bounds: { cpuLimitSeconds: 60, cpuKillGraceSeconds: 5, hangBackstopMs: 300 } }), (error: unknown) => {
      assert.match((error as Error).message, /ended without a status payload: HUNG: it was still running at the 0\.3 s hang backstop \(wall\) and was killed with SIGKILL/u);
      assert.equal((error as { code?: unknown }).code, "script_subprocess_hung");
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a typed refusal printed by a step that was then KILLED is reported as the kill, never as the refusal", () => {
  const { dir, script } = boundedFixture("refused-then-killed", 'process.stderr.write(JSON.stringify({ error: "some_refusal", message: "the step refused" }) + "\\n");\nprocess.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 10_000);\n');
  try {
    assert.throws(() => runScriptSubprocess(dir, script, []), (error: unknown) => {
      assert.match((error as Error).message, /ended without a status payload: it was ended by signal SIGTERM/u);
      assert.notEqual((error as { code?: unknown }).code, "some_refusal");
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// A STEP THAT DID NOT FINISH HAS NO VERDICT (fail-closed). A `build-bundle
// --check` that printed `{"fresh":true}` and then hung was killed, and the
// fragment it had printed was read as its answer: `harness sync` reported
// allPassed. A step ended by a signal or a bound, or with no payload, fails.
// ---------------------------------------------------------------------------

test("FAIL-CLOSED: a step that printed a PASS and was then killed, or ran past its CPU bound, is a failure naming how it ended; a step that answered nothing is one too", () => {
  const killed = boundedFixture("pass-then-killed", 'process.stdout.write(JSON.stringify({ fresh: true, status: "pass" }) + "\\n");\nprocess.kill(process.pid, "SIGTERM");\nsetTimeout(() => {}, 10_000);\n');
  const spun = boundedFixture("pass-then-spun", 'process.stdout.write(JSON.stringify({ fresh: true, status: "pass" }) + "\\n");\nfor (;;) {}\n');
  const silent = boundedFixture("silent-zero", "process.exit(0);\n");
  try {
    assert.throws(() => runScriptSubprocess(killed.dir, killed.script, []), (error: unknown) => {
      assert.match((error as Error).message, /ended without a status payload: it was ended by signal SIGTERM \(the \d+ characters it printed on stdout before it ended are not a verdict\)/u);
      assert.equal((error as { code?: unknown }).code, "script_subprocess_unfinished");
      return true;
    });
    assert.throws(() => runScriptSubprocess(spun.dir, spun.script, [], { bounds: { cpuLimitSeconds: 1, cpuKillGraceSeconds: 5, hangBackstopMs: 120_000 } }), (error: unknown) => {
      assert.match((error as Error).message, /spent its CPU-time limit of 1 s of CPU work \(RLIMIT_CPU\) and was ended by SIGXCPU \(the \d+ characters/u);
      return true;
    });
    assert.throws(() => runScriptSubprocess(silent.dir, silent.script, []), (error: unknown) => {
      assert.match((error as Error).message, /ended without a status payload: it exited with status 0 \(it printed nothing on stderr\)/u);
      return true;
    });
  } finally {
    for (const one of [killed, spun, silent]) rmSync(one.dir, { recursive: true, force: true });
  }
});

test("FAIL-CLOSED: a step that printed a PASS and then exited non-zero, or crashed, did not exit clean; its payload is never its verdict", () => {
  const exited = boundedFixture("pass-then-exit-1", 'process.stdout.write(JSON.stringify({ fresh: true, status: "pass" }) + "\\n");\nprocess.exitCode = 1;\n');
  const crashed = boundedFixture("pass-then-crash", 'process.stdout.write(JSON.stringify({ fresh: true, status: "pass" }) + "\\n");\nthrow new Error("the step crashed after printing");\n');
  const clean = boundedFixture("pass-clean", 'process.stdout.write(JSON.stringify({ fresh: true, status: "pass" }) + "\\n");\n');
  try {
    // Only the clean branch carries a payload; a failed one carries what it printed, under another name.
    assert.deepEqual(runScriptSubprocess(exited.dir, exited.script, []), { ok: false, ending: "it exited with status 1", printed: '{"fresh":true,"status":"pass"}' });
    assert.deepEqual(runScriptSubprocess(crashed.dir, crashed.script, []), { ok: false, ending: "it exited with status 1", printed: '{"fresh":true,"status":"pass"}' });
    assert.deepEqual(runScriptSubprocess(clean.dir, clean.script, []), { ok: true, payload: '{"fresh":true,"status":"pass"}' });
  } finally {
    for (const one of [exited, crashed, clean]) rmSync(one.dir, { recursive: true, force: true });
  }
});

/** A stand-in engine: a CLI whose every step answers a signed pass, `check` then ending as `checkEnding` says, and a bundle check answering fresh with `bundleExit`. */
async function syncOverStandIn(checkEnding: string, bundleExit = 0): Promise<Awaited<ReturnType<typeof harnessSync>>> {
  const dir = createTempDir("harness-sync-stand-in-");
  try {
    const engine = join(dir, "engine");
    mkdirSync(join(engine, "src"), { recursive: true });
    mkdirSync(join(engine, "scripts"), { recursive: true });
    execFileSync("git", ["init", "-q", dir]);
    const resultOwner = pathToFileURL(resolve("src", "workflow", "command-result.ts")).href;
    writeFileSync(join(engine, "src", "cli.ts"), [
      `const { wrapResult } = await import(${JSON.stringify(resultOwner)});`,
      "const step = process.argv[3];",
      "process.stdout.write(JSON.stringify(wrapResult(step, { ok: true }, { status: \"pass\" })) + \"\\n\");",
      `if (step === "check") { ${checkEnding} }`,
    ].join("\n"));
    writeFileSync(join(engine, "scripts", "build-bundle.ts"), [
      'if (process.argv.includes("--check")) process.stdout.write(JSON.stringify({ fresh: true, status: "fresh", path: "dist/bundle.js" }) + "\\n");',
      'else process.stdout.write(JSON.stringify({ built: true }) + "\\n");',
      `process.exitCode = ${String(bundleExit)};`,
    ].join("\n"));
    return await harnessSync(engine);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("FAIL-CLOSED, end to end: a `harness sync` whose check step prints a pass and is then KILLED, exits non-zero or crashes fails the whole sync, naming the step", async () => {
  for (const [ending, said] of [
    ['process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 10_000);', /it was ended by signal SIGTERM/u],
    ["process.exitCode = 1;", /failed: it exited with status 1, after printing a pass/u],
    ['throw new Error("the check crashed after printing");', /failed: it exited with status 1, after printing a pass/u],
  ] as const) {
    const result = await syncOverStandIn(ending);
    assert.equal(result.status, "fail", `a check that ends with ${ending} can never leave the sync passing`);
    assert.equal(result.result.allPassed, false);
    assert.equal(result.result.steps.find((step) => step.step === "check")?.status, "fail");
    const told = JSON.stringify(result.result.check.result);
    assert.match(told, /harness sync step 'check' /u);
    assert.match(told, said);
  }
  // The control: the same stand-in with a clean check passes, so the arms above fail for their ending alone.
  assert.equal((await syncOverStandIn("")).status, "pass");
  // A bundle check that printed "fresh" and exited non-zero is NOT fresh: the sync rebuilds the bundle.
  const unclean = await syncOverStandIn("", 1);
  assert.notEqual(unclean.result.bundleBuild, undefined, "an unclean freshness answer never skips the rebuild");
  assert.equal(unclean.result.bundleBuild?.status, "fail", "and a build that exited non-zero failed, whatever it printed");
  assert.equal(unclean.status, "fail");
});

/**
 * EVERY ARM THAT READS A SCRIPT'S ANSWER, one row each: the arm's own
 * "current"/"pass" payload, printed by a stand-in for its script. Exiting 0,
 * the arm judges it current (the control); exiting 1 after printing the very
 * same payload, it never does.
 */
const CLEAN_EXIT_ARMS: readonly Readonly<{ arm: string; script: string; payload: unknown; current: (root: string) => boolean }>[] = [
  {
    arm: "the disposition auto-add",
    script: "scripts/tooling/run-tests.ts",
    payload: { status: "current", addedCount: 0, addedPaths: [], prunedCount: 0, prunedPaths: [] },
    current: (root) => {
      try {
        return autoAddDispositionEntries(root, true, []).status === "current";
      } catch (error) {
        assert.equal((error as { code?: unknown }).code, "disposition_auto_add_failed");
        return false;
      }
    },
  },
  {
    arm: "the test-inventory regenerate arm",
    script: "scripts/test-inventory.ts",
    payload: { status: "current", testCount: 3, inventoryHash: "0123456789abcdef" },
    current: (root) => regenerateTestInventory(root, false).status === "current",
  },
  {
    arm: "the pin-authority arm",
    script: "scripts/pin-authority-regeneration.ts",
    payload: { allCurrent: true, results: [{ status: "current" }] },
    current: (root) => regeneratePinAuthorities(root, false).converged,
  },
  {
    arm: "the ratchet-baseline arm",
    script: "scripts/verification/ratchet-baselines.ts",
    payload: { allCurrent: true, results: [] },
    current: (root) => regenerateRatchetBaselines(root, false).converged,
  },
  {
    arm: "the generator arm (decision index, shipped hooks, README consumers)",
    script: "scripts/generator.ts",
    payload: { allCurrent: true, status: "current", changed: [] },
    current: (root) => generatorReport(root, "scripts/generator.ts", ["--check"], "a generator", "generator_no_result").allCurrent,
  },
  {
    arm: "the check's inventory step",
    script: "scripts/test-inventory.ts",
    payload: { status: "current", testCount: 3, inventoryHash: "0123456789abcdef", transactionPresent: false },
    current: (root) => runInventoryCheck(root).status === "pass",
  },
];

test("FAIL-CLOSED, every arm: a script that prints its arm's current/pass answer and then exits 1 is never judged current; exiting 0 it is", () => {
  for (const row of CLEAN_EXIT_ARMS) {
    for (const exit of [0, 1] as const) {
      const dir = createTempDir("harness-arm-exit-");
      try {
        // The test surface the inventory and disposition arms look for, as stand-ins answering this row's payload.
        for (const script of ["scripts/tooling/run-tests.ts", "scripts/test-inventory.ts", row.script]) {
          mkdirSync(join(dir, script, ".."), { recursive: true });
          writeFileSync(join(dir, script), `process.stdout.write(${JSON.stringify(JSON.stringify(row.payload))} + "\\n");\nprocess.exitCode = ${String(exit)};\n`);
        }
        assert.equal(row.current(dir), exit === 0, `${row.arm}, exiting ${String(exit)} after printing its current answer`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});
