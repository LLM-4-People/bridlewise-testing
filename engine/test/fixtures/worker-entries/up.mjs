// A bootstrapped thread that starts and answers (DECLARED_WORKER_ENTRIES, src/process/worker-bootstrap.ts).
import { parentPort } from "node:worker_threads";

parentPort.postMessage("up");
