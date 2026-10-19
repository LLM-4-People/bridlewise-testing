import test, { type TestContext } from "node:test";

import { executePlannedNodeTestFamily } from "../../scripts/tooling/planned-node-test.ts";
import {
  createRepositoryPathPlannedCatalog,
  type RepositoryPathTestId,
} from "./repository-path-test-catalog.ts";
import { runRepositoryPathTestOracle } from "./repository-path-test-oracles.ts";

const CATALOG = createRepositoryPathPlannedCatalog(runRepositoryPathTestOracle);

function execute(id: RepositoryPathTestId, context: TestContext): Promise<void> {
  return executePlannedNodeTestFamily(CATALOG, id, context);
}

test("[RPA-U001] official source and generated authority identities", (context) => execute("RPA-U001", context));
test("[RPA-U002] all Unicode 17 C plus F mappings and production Q keys", (context) => execute("RPA-U002", context));
test("[RPA-U003] all Unicode 17 normalization conformance assertions", (context) => execute("RPA-U003", context));
test("[RPA-U004] source generated table and manifest mutations fail closed", (context) => execute("RPA-U004", context));
test("[RPA-G001] vendored Git source license and upstream test identities", (context) => execute("RPA-G001", context));
test("[RPA-G002] exact Git NTFS aliases cover every fallback width and boundary", (context) => execute("RPA-G002", context));
test("[RPA-L001] scalar syntax normalization and exhaustive surrogate classes", (context) => execute("RPA-L001", context));
test("[RPA-L002] Win32 characters trailing aliases and reserved devices", (context) => execute("RPA-L002", context));
test("[RPA-L003] exact Git and strict-profile contextual symlink aliases", (context) => execute("RPA-L003", context));
test("[RPA-L004] all configurable bounds at below exact and above limits", (context) => execute("RPA-L004", context));
test("[RPA-S001] trap-free set snapshot rejects hostile structures", (context) => execute("RPA-S001", context));
test("[RPA-S002] ordinal-only collision evidence and canary-safe errors", (context) => execute("RPA-S002", context));
test("[RPA-B001] runtime path authorities reject direct import and cast forgery", (context) => execute("RPA-B001", context));
test("[RPA-C001] central config owns actual bounds under closed profile", (context) => execute("RPA-C001", context));
test("[RPA-E001] generator defaults read-only and write remains unavailable", (context) => execute("RPA-E001", context));
