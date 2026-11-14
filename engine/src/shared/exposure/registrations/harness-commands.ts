/**
 * Shared exposure registrations — `harnessCommands` module.
 *
 * The bounds on the harness's own maintenance doors: how every harness
 * subprocess is bounded (`harness.subprocessBounds`: its CPU budget, the
 * busy share below which it is not working, the stall window, the one wall
 * hang backstop, how often it is read, the stop's grace and its output), how the shared lock behaves when the test
 * command holds it, how long the evaluation runner's identity probe may
 * take, and the shared command runner's read-only first-failure policy.
 *
 * THE DISPOSITION DOCTRINE (this class's census, tests/prevention/
 * exposure-reachable.test.ts): the rows span three config sections
 * (`harness`, `resourceLock`, `evaluation`) because they answer ONE user
 * question — how the harness's own commands are bounded — and the census
 * binds every row by config path, so a row moved between modules stays
 * disposed. Each is an administrative RUN BOUND: no verdict depends on it,
 * a shorter bound fails closed (the step is abandoned and reported), the
 * same class the benchmark and workspace timeout bounds belong to. The
 * class's remaining leaves are FILED by the census: the evaluation
 * section's `maxOutputTokens` has reader code (the matrix generator accepts
 * the knob) but no production path forwards the document's value into it —
 * the wiring gap, filed with the missing consumer named.
 *
 * THE HONEST TIMING: every consumer is an engine command door — a fresh
 * process that resolves the pinned config document once per invocation —
 * so a settings write lands in the file and the NEXT run of that command
 * reads it.
 */

import {
  registerCustomization,
  registerSignal,
  registerExposureModule,
} from "../index.ts";
import { readNumberCustomization, writeConfigCustomization } from "../config-binding.ts";
import {
  CHECKOUT_COMMAND_FAILURE_POLICY,
  subprocessBounds,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_LOCK_POLL_INTERVAL_MS,
  DEFAULT_LOCK_STALE_MS,
} from "../../../workflow/workflow-config.ts";
import { IDENTITY_ATTESTATION_TIMEOUT_MS } from "../../../evaluation/evaluation-config.ts";

/** The subprocess bounds' defaults, as their owner resolves them for a document that configures none. */
const SUBPROCESS_DEFAULTS = subprocessBounds({});

const ROWS = [
  {
    id: "subprocessCpuBudgetMs",
    configPath: "harness.subprocessBounds.cpuBudgetMs",
    name: "How much CPU work a harness step may do",
    description:
      "A step the harness runs as a subprocess (a sync or check step, the typecheck, a commit's compile check) is stopped once it and every process it started have used this much CPU time together, and is reported as over its budget. Busy machines do not count against it: only the step's own work does. Lower = a runaway step is stopped sooner; higher = a heavy step on a large tree still finishes. Takes effect on the next run.",
    default: SUBPROCESS_DEFAULTS.cpuBudgetMs,
    min: 1000,
    max: 86400000,
    unit: "milliseconds",
  },
  {
    id: "subprocessStallMs",
    configPath: "harness.subprocessBounds.stallMs",
    name: "How long a harness step may make no progress",
    description:
      "A step that prints nothing and does less work than the busy share above for this long is stopped and reported as stalled. A slow machine does not make a working step stall. Lower = a stuck step is reported sooner; higher = a step that waits on something slow is given longer. Takes effect on the next run.",
    default: SUBPROCESS_DEFAULTS.stallMs,
    min: 1000,
    max: 86400000,
    unit: "milliseconds",
  },
  {
    id: "subprocessHangBackstopMs",
    configPath: "harness.subprocessBounds.hangBackstopMs",
    name: "The longest a harness step may run at all",
    description:
      "The one limit on elapsed time: a step still running after this long is stopped and reported as hung, however busy it is. It sits far past any honest step, so a busy machine never reaches it. Lower = a hung step is caught sooner; higher = an unusually long honest step still finishes. Takes effect on the next run.",
    default: SUBPROCESS_DEFAULTS.hangBackstopMs,
    min: 1000,
    max: 604800000,
    unit: "milliseconds",
  },
  {
    id: "subprocessPollMs",
    configPath: "harness.subprocessBounds.pollMs",
    name: "How often a harness step's work is measured",
    description:
      "The harness reads a running step's CPU time and output this often to decide whether it is over budget, stalled or hung. Must be shorter than the stall window. Lower = a stop comes closer to the moment a limit is passed; higher = fewer readings. Takes effect on the next run.",
    default: SUBPROCESS_DEFAULTS.pollMs,
    min: 10,
    max: 60000,
    unit: "milliseconds",
  },
  {
    id: "subprocessKillGraceMs",
    configPath: "harness.subprocessBounds.killGraceMs",
    name: "How long a stopped harness step gets to exit",
    description:
      "When a step is stopped, it is first asked to exit and then, after this long, ended outright, together with every process it started. Lower = a stopped step is gone sooner; higher = it gets longer to clean up. Takes effect on the next run.",
    default: SUBPROCESS_DEFAULTS.killGraceMs,
    min: 10,
    max: 600000,
    unit: "milliseconds",
  },
  {
    id: "subprocessOutputBytes",
    configPath: "harness.subprocessBounds.outputBytes",
    name: "How much output a harness step may print",
    description:
      "A step that prints more than this is stopped and reported as over its output limit; the harness keeps a step's output in memory to read its answer. Lower = a step that floods its output is stopped sooner; higher = a step with a large report still finishes. Takes effect on the next run.",
    default: SUBPROCESS_DEFAULTS.outputBytes,
    min: 65536,
    max: 1073741824,
    unit: "bytes",
  },
  {
    id: "lockTimeoutMs",
    configPath: "resourceLock.timeoutMs",
    name: "How long a command waits to take the shared lock",
    description:
      "Test commands serialize through one lock; a command that cannot take it within this bound gives up with a typed failure instead of queuing forever. Lower = a blocked command reports sooner; higher = a busy machine still gets its turn. Takes effect on the next run.",
    default: DEFAULT_LOCK_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
  {
    id: "lockPollIntervalMs",
    configPath: "resourceLock.pollIntervalMs",
    name: "How often a waiting command rechecks the shared lock",
    description:
      "While waiting for the shared lock, a command rechecks this often. Lower = the lock is claimed the instant it frees, at the cost of more checks; higher = fewer checks, slightly later pickup. Takes effect on the next run.",
    default: DEFAULT_LOCK_POLL_INTERVAL_MS,
    min: 1,
    max: 60_000,
    unit: "milliseconds",
  },
  {
    id: "lockStaleMs",
    configPath: "resourceLock.staleMs",
    name: "How old an unreadable lock file is before it is taken over",
    description:
      "A lock file no harness process wrote (another format, a hand-made file) is honoured for this long, then taken over, so a foreign leftover cannot block the next command forever. A live holder is never taken over, however long it holds the lock, and a dead holder's lock is taken over at once. Lower = a foreign leftover clears sooner; higher = an unidentified file is kept longer for inspection. Takes effect on the next run.",
    default: DEFAULT_LOCK_STALE_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
  {
    id: "identityAttestationTimeoutMs",
    configPath: "evaluation.identityAttestationTimeoutMs",
    name: "How long the evaluation identity probe may run",
    description:
      "The evaluation runner probes each model's identity before trusting it; the probe is bounded by this. Lower = an unresponsive model is refused sooner; higher = a slow provider still gets to answer. Takes effect on the next evaluation run.",
    default: IDENTITY_ATTESTATION_TIMEOUT_MS,
    min: 1,
    max: 600_000,
    unit: "milliseconds",
  },
] as const;


let harnessCommandsRegistered = false;
export function registerHarnessCommandsExposure(): void {
  if (harnessCommandsRegistered) return;
  harnessCommandsRegistered = true;

  registerExposureModule({
    id: "harnessCommands",
    title: "How the harness's own commands are bounded",
    purpose:
      "How long the harness's own maintenance steps may run — how much work a step may do, how long it may make no progress, the longest it may run, the shared lock its test command holds, the evaluation runner's identity probe — and how the first command outcome is preserved.",
  });

  registerSignal({
    id: "harnessCommands.commandFailurePolicy",
    module: "harnessCommands",
    name: "How command failures are handled",
    description: "The runner preserves the first attempt and reports whether the command failed, was interrupted or was cancelled. Fix the cause before a new run. Retired retry and backoff configuration fields are refused.",
    type: "state",
    value: () => CHECKOUT_COMMAND_FAILURE_POLICY,
  });

  // The command doors' run bounds, resolved by their existing owners.
  for (const spec of ROWS) {
    registerCustomization({
      id: `harnessCommands.${spec.id}`,
      module: "harnessCommands",
      name: spec.name,
      description: spec.description,
      type: "number",
      default: spec.default,
      min: spec.min,
      max: spec.max,
      unit: spec.unit,
      current: () => readNumberCustomization(spec.configPath, spec.default),
      set: (v) => writeConfigCustomization(spec.configPath, v),
      contract: { effect: "next-run" },
      configPath: spec.configPath,
    });
  }
}

/** Reset the per-module registration flag (test-only). */
export function resetHarnessCommandsRegistration(): void {
  harnessCommandsRegistered = false;
}
