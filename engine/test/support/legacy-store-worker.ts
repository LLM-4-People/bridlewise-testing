import { Core } from "./legacy-core.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { stateLocationFromPath } from "./legacy-state-boundary.ts";
import { Store } from "./legacy-store.ts";

const [databasePath, command, ...values] = process.argv.slice(2);
let store: Store | undefined;
try {
  if (!databasePath || !command) throw new Error("invalid test worker arguments");
  store = new Store(stateLocationFromPath(databasePath));
  const core = new Core(store);
  let output: object;
  switch (command) {
    case "init":
      output = { schemaVersion: 1, status: "initialized" };
      break;
    case "request-submit":
      output = core.submitRequest(values[0]!, values[1]!);
      break;
    case "request-wait":
      output = core.waitForUser(values[0]!, values[1]!);
      break;
    case "request-answer":
      output = core.answerWait(values[0]!, values[1]!);
      break;
    case "request-complete":
      output = core.finishRequest(values[0]!, "completed", values[1]!);
      break;
    default:
      throw new Error("unknown test worker command");
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    errorClass: error instanceof Error ? error.constructor.name : "Error",
    code: error instanceof HarnessError ? error.code : "test_worker_error",
  })}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
