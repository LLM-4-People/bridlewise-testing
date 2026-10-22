/**
 * THE WEB SUITE'S PER-TEST JUDGEMENT: CPU WORK, BY CLASS (NO-LOAD-BLOCK L2).
 *
 * Installs the one judgement both suites share
 * (engine/scripts/tooling/test-cpu-class.ts) into every web test: a test is
 * judged by the CPU work it did against its file's class ceiling
 * (`testExecution.testCpuClasses`), never by its wall time. The reading is
 * kept on the test (`meta.cpuMs`, `meta.wallMs`) for the reporters, so the
 * JSON report carries each test's work beside its duration.
 *
 * The one wall bound left, vitest's `testTimeout`/`hookTimeout`, is the HANG
 * BACKSTOP (`testExecution.testHangBackstopMs`, wired in vitest.config.ts). A
 * test that reaches it is classified `hung` here, with the work it had done:
 * a hang is a different finding from a slow test, and says so.
 */
import { relative, sep } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { TestContext } from "vitest";

import { deadClassFiles, installTestCpuJudgement } from "../../engine/scripts/tooling/test-cpu-class.ts";
import { readTestCpuClasses } from "../helpers/budget-config.ts";

declare module "vitest" {
  interface TaskMeta {
    /** This test's CPU work (its process and the children it reaped), in ms: the judged reading. */
    cpuMs?: number;
    /** This test's wall time, in ms: recorded, never judged. */
    wallMs?: number;
  }
}

const classes = readTestCpuClasses();
if ("missing" in classes) throw new Error(classes.missing);
// The suite runs from the repository root (vitest.config.ts pins it).
const ROOT = process.cwd();
const dead = deadClassFiles(classes, ROOT);
if (dead !== null) throw new Error(dead);

installTestCpuJudgement<TestContext>(
  { beforeEach, afterEach },
  classes,
  (context) => relative(ROOT, context.task.file.filepath).split(sep).join("/"),
  (context, reading) => {
    context.task.meta.cpuMs = reading.cpuMs;
    context.task.meta.wallMs = reading.wallMs;
    const timedOut = (context.task.result?.errors ?? []).some((error) => /timed out in \d+ms/u.test(String(error.message)));
    if (timedOut) {
      throw new Error(
        `hung: this test was still running at its ${String(context.task.timeout)} ms hang backstop (testExecution.testHangBackstopMs) ` +
          `after ${String(reading.cpuMs)} ms of CPU work. A hang is not a slow test: find what it waits for.`,
      );
    }
  },
);
