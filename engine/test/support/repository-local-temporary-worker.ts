import { existsSync } from "node:fs";

import {
  createRepositoryLocalTemporaryDirectory,
  isolateRepositoryLocalOwners,
  removeRepositoryLocalTemporaryRoot,
} from "./repository-local-temporary.ts";

const mode = process.argv[2];
const namespace = process.argv[3];
if (process.argv.length !== 4 || (mode !== "retain" && mode !== "cleanup" && mode !== "hold") || namespace === undefined) {
  throw new Error("Usage: repository-local-temporary-worker retain|cleanup|hold <owner namespace>");
}
isolateRepositoryLocalOwners(namespace);
const path = createRepositoryLocalTemporaryDirectory("cross-process-");
if (mode === "cleanup") removeRepositoryLocalTemporaryRoot();
process.stdout.write(`${JSON.stringify({ path, exists: existsSync(path) })}\n`);
if (mode === "hold") await new Promise<void>(() => setInterval(() => undefined, 1_000));
