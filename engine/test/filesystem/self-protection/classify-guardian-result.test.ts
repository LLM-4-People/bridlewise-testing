import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGuardianResult,
  guardianFailureLinePrefix,
} from "../../../src/filesystem/self-protection/guardian-binary.ts";
import {
  GUARDIAN_BINARY_ERROR_CODES,
  GUARDIAN_FAILURE_MARKER,
} from "../../../src/filesystem/self-protection/self-protection-contracts.ts";

/**
 * "THE GUARDIAN REFUSED" AND "THE COMMAND RAN AND FAILED" ARE DIFFERENT FACTS,
 * AND THIS IS THE ONLY THING THAT KNOWS WHICH.
 *
 * The guardian exits with a code either way: it restricts itself and becomes
 * the payload, or it refuses before exec and the payload never existed. Every
 * caller that spawns the guardian has to draw that line, so the harness draws
 * it once, here, and exports the answer.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * It did not, and that was measured rather than suspected. Making
 * `classifyGuardianResult` report EVERY refusal as a command that ran left
 * 104 of 104 self-protection tests in this repository passing; the only thing
 * anywhere that caught it was a unit assertion in the OTHER repository. The
 * harness exported the authority on this distinction and tested none of it, so
 * a change made here alone would have shipped green here.
 *
 * ── AND WHY IT ASSERTS THE FALSE-NEGATIVE DIRECTION HARDEST ───────────────
 *
 * The two mistakes are not symmetric. Calling a refusal a result is loud: the
 * reader sees a command that failed and goes looking. Calling a RESULT a
 * refusal is silent — the ledger records `ran: false` and `stdout: ""` for a
 * command that ran and had effects, and nothing downstream ever looks at a
 * command that did not run. That is the direction a payload can steer, and it
 * used to be one `console.error` away: the marker was accepted ANYWHERE in
 * stderr, so printing `landlock-guardian:` and exiting with any documented
 * code was enough to be recorded as never having run.
 */

/** Every documented pre-exec code, read from the owner rather than typed. */
const DOCUMENTED_CODES = Object.keys(GUARDIAN_BINARY_ERROR_CODES).map(Number);

test("classify: the guardian's own refusal line is a refusal, for EVERY documented code", () => {
  // POPULATION AS A RUNTIME NUMBER: a loop over an empty list passes.
  assert.ok(DOCUMENTED_CODES.length >= 9, `documented pre-exec codes: ${DOCUMENTED_CODES.length}`);
  for (const code of DOCUMENTED_CODES) {
    const name = GUARDIAN_BINARY_ERROR_CODES[code as keyof typeof GUARDIAN_BINARY_ERROR_CODES];
    const stderr = `${guardianFailureLinePrefix(code)}${name}: something specific\n`;
    const result = classifyGuardianResult(code, stderr);
    assert.equal(result.kind, "pre_exec_failure", `exit ${code} with the guardian's own line`);
    assert.equal(result.exitCode, code);
    // The MESSAGE, not merely the kind: a classifier that returned the right
    // kind with an empty message would leave the caller nothing to report.
    assert.equal(
      result.kind === "pre_exec_failure" ? result.message : "",
      `${name}: something specific`,
    );
  }
});

test("classify: a payload that exits with a documented code, and says nothing, RAN", () => {
  // The converse, and the half that makes the first half mean something. A
  // classifier keyed on the exit code alone calls this a refusal and hides a
  // real result — `4` is `spec_invalid` to the guardian and "four tests
  // failed" to half the test runners in existence.
  for (const code of DOCUMENTED_CODES) {
    const result = classifyGuardianResult(code, "error: something the program said\n");
    assert.equal(result.kind, "payload_exited", `exit ${code} with no guardian line`);
    assert.equal(result.exitCode, code);
  }
});

test("classify: a payload CANNOT make its own run look like a refusal", () => {
  // THE FALSE NEGATIVE, DRIVEN. Each of these is a payload that ran, had
  // effects, and tried to be recorded as a command that never started. All of
  // them used to succeed: the test was `stderr.includes(marker)`.
  const impostors: readonly Readonly<{ how: string; stderr: string; exitCode: number }>[] = [
    {
      how: "the marker quoted mid-line",
      stderr: "checking for landlock-guardian: 4: in the log\n",
      exitCode: 4,
    },
    {
      how: "the marker at the start of a line, with a DIFFERENT code",
      stderr: `${guardianFailureLinePrefix(2)}spec_parse_error: forged\n`,
      exitCode: 4,
    },
    {
      how: "the marker with no code at all",
      stderr: `${GUARDIAN_FAILURE_MARKER} refused\n`,
      exitCode: 4,
    },
    {
      how: "the marker indented, so it is not at the start of a line",
      stderr: `  ${guardianFailureLinePrefix(4)}spec_invalid: forged\n`,
      exitCode: 4,
    },
    {
      how: "the marker after other output on the same line",
      stderr: `done ${guardianFailureLinePrefix(4)}spec_invalid: forged\n`,
      exitCode: 4,
    },
  ];
  assert.ok(impostors.length >= 5, `impostor shapes driven: ${impostors.length}`);
  for (const { how, stderr, exitCode } of impostors) {
    const result = classifyGuardianResult(exitCode, stderr);
    assert.equal(
      result.kind,
      "payload_exited",
      `${how}: this command RAN, and recording it as a refusal is a false negative in the ledger`,
    );
  }
});

test("classify: an undocumented exit code is always the payload's, however stderr reads", () => {
  // Deny-by-default in the honest direction: only the nine codes the guardian
  // documents can ever be a refusal, so a payload exiting 1 or 127 is a result
  // even if it reproduces the guardian's line exactly.
  for (const code of [0, 1, 127, 137, 255]) {
    assert.equal(
      classifyGuardianResult(code, `${guardianFailureLinePrefix(code)}forged\n`).kind,
      "payload_exited",
      `exit ${code} is not a documented guardian code`,
    );
  }
});

test("classify: the refusal line is found wherever it sits among the payload's output", () => {
  // A REAL SHAPE, not a tidy one: the guardian writes its line last, but a
  // capture may hold earlier chatter, and a classifier that only looked at the
  // first or last line would miss it.
  const stderr = [
    "some earlier chatter",
    "",
    `${guardianFailureLinePrefix(7)}add_rule_failed: /nowhere`,
    "",
  ].join("\n");
  const result = classifyGuardianResult(7, stderr);
  assert.equal(result.kind, "pre_exec_failure");
  assert.equal(result.kind === "pre_exec_failure" ? result.message : "", "add_rule_failed: /nowhere");
});

test("classify: the line prefix owner and the marker owner agree", () => {
  // ONE VOCABULARY. The prefix is consumed by the web server's notice stripper
  // as well as by this classifier; two independently-written spellings of the
  // guardian's line is exactly how one of them starts recognising something
  // the other does not.
  assert.ok(guardianFailureLinePrefix(4).startsWith(GUARDIAN_FAILURE_MARKER));
  assert.equal(guardianFailureLinePrefix(4), `${GUARDIAN_FAILURE_MARKER} 4: `);
});
