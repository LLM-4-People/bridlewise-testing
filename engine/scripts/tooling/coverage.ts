import { fileURLToPath } from "node:url";
import { spec } from "node:test/reporters";

import { executeInventoryTestRun } from "./inventory-test-run.ts";
import { loadTestInventory } from "../test-inventory.ts";
import { asLockDoor, enforceTestRunLock, wholeInstrumentRun } from "./test-run-lock.ts";
import { INSIDE_INSTRUMENT_LOCK_VARIABLE, runInsideInstrumentLock } from "../../src/workflow/slot-cli.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

export async function runInventoryCoverage(candidateRoot: string): Promise<0 | 1> {
  const inventory = loadTestInventory(candidateRoot);
  const reporter = spec();
  reporter.pipe(process.stdout, { end: false });
  const accounting = await executeInventoryTestRun(candidateRoot, inventory, {
    coverage: true,
    reporter,
  });
  return accounting.passed ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const root = fileURLToPath(new URL("../../", import.meta.url));
  await asLockDoor(async () => {
    if (process.env[INSIDE_INSTRUMENT_LOCK_VARIABLE] !== "1") {
      // A coverage run IS the suite plus instrumentation — same cores, same
      // contention — so it holds the same one lock, through the supervising door:
      // this process re-runs itself under the native supervisor inside the hold,
      // so a door killed outright never frees the lock under the run (L-N1).
      process.exitCode = (await runInsideInstrumentLock("engine coverage run", wholeInstrumentRun("coverage"),
        [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)])).exitCode;
      return;
    }
    // INSIDE: the hold is BORROWED through the one door, which refuses it outside a live hold — the marker never
    // grants the lock (correctness L-L1: a self-asserted flag ran the whole suite with coverage, unlocked).
    const lock = await enforceTestRunLock("engine coverage run", { testFileCount: wholeInstrumentRun("coverage"), inProcess: true });
    try {
      process.exitCode = await runInventoryCoverage(root);
    } finally {
      lock.release();
    }
  });
}
