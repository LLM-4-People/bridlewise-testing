import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../../src/cli.ts";
import { HARNESS_SUBCOMMANDS } from "../../src/workflow/harness-commands.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

/**
 * INVARIANTS #60, #61, #62: CLI global flags.
 *
 * The CLI must print usage on --help, the package version on --version, and
 * full stack traces on --verbose when an error occurs. All three are
 * deterministic (no network, no config load) and must exit 0 for help/version.
 */

function captureStreams<T>(fn: () => Promise<T>): Promise<{
  stdout: string;
  stderr: string;
  result: T;
}> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  return fn().then(
    (result) => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      return { stdout, stderr, result };
    },
    (error) => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      throw error;
    },
  );
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}

// ============================================================================
// #60: --help prints usage
// ============================================================================

test("CLI: --help prints usage and exits 0", async () => {
  const { stdout, result } = await captureStreams(() => runCli(["--help"]));
  assert.equal(result, 0, "--help must exit 0");
  assert.ok(
    stdout.includes("Usage") || stdout.includes("Commands"),
    "--help output must contain 'Usage' or 'Commands'",
  );
});

test("CLI: -h is an alias for --help", async () => {
  const { stdout, result } = await captureStreams(() => runCli(["-h"]));
  assert.equal(result, 0);
  assert.ok(stdout.includes("Usage"));
});

test("CLI: no command prints help and exits 0", async () => {
  const { stdout, result } = await captureStreams(() => runCli([]));
  assert.equal(result, 0);
  assert.ok(stdout.includes("Usage") || stdout.includes("Commands"));
});

test("CLI (UX-0): `--` ends the global flags — a door's command keeps its own -v/--help — and --help after a command is that command's help, never the top level", async () => {
  // After `--` the arguments are the command's: `harness slot` reads them (here it refuses its malformed verb, which
  // proves `-v` reached it instead of printing the version).
  const swallowed = await captureStreams(() => runCli(["harness", "slot", "nope", "--", "echo", "-v"]));
  assert.equal(swallowed.result, 1, "the command ran (and refused its verb), the version was not printed");
  assert.ok(!swallowed.stdout.includes("bridlewise "), "no version line");
  assert.match(swallowed.stderr, /harness slot takes: run -- <command>/u);
  // --help after a command: the harness's own help (its subcommands), never the top-level command list.
  const harnessHelp = await captureStreams(() => runCli(["harness", "--help"]));
  assert.equal(harnessHelp.result, 0);
  assert.match(harnessHelp.stdout, /Usage: bridlewise harness <subcommand>/u);
  for (const sub of HARNESS_SUBCOMMANDS) assert.ok(harnessHelp.stdout.includes(`  ${sub}\n`), `the harness help lists ${sub}`);
  assert.ok(!harnessHelp.stdout.includes("Run language quality pack checks"), "not the top-level help");
  const subHelp = await captureStreams(() => runCli(["harness", "slot", "--help"]));
  assert.equal(subHelp.result, 0, "a subcommand's --help never runs the subcommand");
  assert.match(subHelp.stdout, /Usage: bridlewise harness slot/u);
  // Before `--`, the global flags still work.
  const version = await captureStreams(() => runCli(["-v"]));
  assert.equal(version.result, 0);
  assert.match(version.stdout, /^bridlewise /u);
});

// ============================================================================
// Unknown-command guidance (S74 / S73-W2): the error must route a known
// harness subcommand to its `harness` parent, and give a generic listing for
// an unrecognized command. The known-subcommand set is derived from the
// single owner (HARNESS_SUBCOMMANDS) — never a parallel literal.
// ============================================================================

test("CLI: every harness subcommand without the parent names the parent in the error", async () => {
  const parent = ROOT_POLICY.protocol.harnessCommand;
  // Deny-by-default over the WHOLE set: a subcommand added to
  // HARNESS_SUBCOMMANDS tomorrow is automatically driven here.
  assert.ok(HARNESS_SUBCOMMANDS.length > 0, "the known-subcommand set must not be empty");
  for (const sub of HARNESS_SUBCOMMANDS) {
    const { stderr, result } = await captureStreams(() => runCli([sub]));
    assert.equal(result, 1, `bare '${sub}' must exit 1`);
    const parsed = JSON.parse(stderr.trim().split("\n")[0]!) as { error: string; message: string };
    assert.equal(parsed.error, "command_unavailable");
    // The example invocation `harness <sub>` must appear (parent + subcommand
    // adjacent inside the suggested command), and the parent must be named as
    // the grouping command.
    assert.ok(
      parsed.message.includes(`${parent} ${sub}`),
      `bare '${sub}' must show the parent + subcommand invocation: got "${parsed.message}"`,
    );
    assert.ok(
      parsed.message.includes(`\`${parent}\` parent`),
      `bare '${sub}' must name the '${parent}' parent: got "${parsed.message}"`,
    );
    assert.ok(
      parsed.message.includes("ride the"),
      `bare '${sub}' must explain the parent relationship: got "${parsed.message}"`,
    );
  }
});

test("CLI: an unrecognized command lists the top-level commands", async () => {
  const { stderr, result } = await captureStreams(() => runCli(["bogus-not-a-command"]));
  assert.equal(result, 1);
  const parsed = JSON.parse(stderr.trim().split("\n")[0]!) as { error: string; message: string };
  assert.equal(parsed.error, "command_unavailable");
  const parent = ROOT_POLICY.protocol.harnessCommand;
  for (const top of [ROOT_POLICY.protocol.preflightCommand, ROOT_POLICY.protocol.qualityCommand, parent]) {
    assert.ok(parsed.message.includes(top), `generic message must list '${top}': got "${parsed.message}"`);
  }
  // Must NOT claim the unknown token is a harness subcommand.
  assert.ok(!parsed.message.includes("ride the"), "generic message must not use the parent hint");
});

// ============================================================================
// #61: --version prints version
// ============================================================================

test("CLI: --version prints package version and exits 0", async () => {
  const expected = readPackageVersion();
  const { stdout, result } = await captureStreams(() => runCli(["--version"]));
  assert.equal(result, 0, "--version must exit 0");
  assert.ok(
    stdout.includes(expected),
    `--version output must contain package version '${expected}'`,
  );
});

test("CLI: -v is an alias for --version", async () => {
  const expected = readPackageVersion();
  const { stdout, result } = await captureStreams(() => runCli(["-v"]));
  assert.equal(result, 0);
  assert.ok(stdout.includes(expected));
});

// ============================================================================
// #62: --verbose enables stack traces
// ============================================================================

test("CLI: --verbose prints a stack trace on error", async () => {
  // Trigger a deterministic error: preflight takes no additional arguments, so
  // passing an extra argument throws InputError("preflight takes no additional
  // arguments"). With --verbose the stack trace is written to stderr.
  const { stderr, result } = await captureStreams(() =>
    runCli(["--verbose", "preflight", "unexpected-arg"]),
  );
  assert.notEqual(result, 0, "an error must produce a non-zero exit code");
  assert.ok(
    /at\s/m.test(stderr) || /Error:/m.test(stderr),
    "--verbose must print a stack trace (containing 'at ' or 'Error:') to stderr",
  );
});

test("CLI: --debug is an alias for --verbose and prints a stack trace", async () => {
  const { stderr, result } = await captureStreams(() =>
    runCli(["--debug", "preflight", "unexpected-arg"]),
  );
  assert.notEqual(result, 0);
  assert.ok(/at\s/m.test(stderr) || /Error:/m.test(stderr));
});

test("CLI: without --verbose, no stack trace is printed on error", async () => {
  const { stderr, result } = await captureStreams(() =>
    runCli(["preflight", "unexpected-arg"]),
  );
  assert.notEqual(result, 0);
  // Without --verbose the error is a canonical JSON object, not a stack trace.
  assert.ok(
    !/\n\s*at\s/m.test(stderr),
    "without --verbose, no stack trace should be printed",
  );
});

test("CLI (design LOW 13): --help for a harness subcommand that does not exist is a typed refusal, never the general list", async () => {
  const unknown = await captureStreams(() => runCli(["harness", "no-such-verb", "--help"]));
  assert.equal(unknown.result, 1);
  assert.match(unknown.stderr, /unknown_harness_subcommand/u);
  assert.match(unknown.stderr, /unknown harness subcommand: no-such-verb/u);
  assert.ok(!unknown.stdout.includes("Usage: bridlewise harness <subcommand>"), "not the general list");
});
