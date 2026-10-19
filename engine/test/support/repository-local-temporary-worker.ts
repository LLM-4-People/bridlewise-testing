import { existsSync } from "node:fs";

import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryRoot,
} from "./repository-local-temporary.ts";

const mode = process.argv[2];
if (process.argv.length !== 3 || (mode !== "retain" && mode !== "cleanup" && mode !== "hold")) {
  throw new Error("Usage: repository-local-temporary-worker retain|cleanup|hold");
}
const path = createRepositoryLocalTemporaryDirectory("cross-process-");
if (mode === "cleanup") removeRepositoryLocalTemporaryRoot();
process.stdout.write(`${JSON.stringify({ path, exists: existsSync(path) })}\n`);
if (mode === "hold") await new Promise<void>(() => setInterval(() => undefined, 1_000));
