// A bootstrapped thread that reports the fault role its prelude installed and its own workerData.
import { parentPort, workerData } from "node:worker_threads";

import { processFaultRole } from "../../../src/process/fault-policy.ts";

parentPort.postMessage({ role: processFaultRole() ?? "none", mine: workerData.mine });
