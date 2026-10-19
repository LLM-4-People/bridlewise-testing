import test, { type TestContext } from "node:test";

import { executePlannedNodeTestFamily } from "../../scripts/tooling/planned-node-test.ts";
import {
  createHandoffContinuityPlannedCatalog,
  type HandoffContinuityTestId,
} from "./handoff-continuity-test-catalog.ts";
import { runHandoffContinuityTestOracle } from "./handoff-continuity-test-oracles.ts";

const CATALOG = createHandoffContinuityPlannedCatalog(runHandoffContinuityTestOracle);

function execute(id: HandoffContinuityTestId, context: TestContext): Promise<void> {
  return executePlannedNodeTestFamily(CATALOG, id, context);
}

test("[HCF-S001] non-finite numbers fail at every structural position", (context) => execute("HCF-S001", context));
test("[HCF-S002] proxies and accessors are rejected without executing caller code", (context) => execute("HCF-S002", context));
test("[HCF-S003] hidden inherited cyclic and non-JSON structures fail closed", (context) => execute("HCF-S003", context));
test("[HCF-L001] configured identifier and root structural ceilings are exact", (context) => execute("HCF-L001", context));
test("[HCF-C001] assignment compilation and inspection bind immutable authority bytes", (context) => execute("HCF-C001", context));
test("[HCF-D001] matching handoff is held with unavailable nominal authorities", (context) => execute("HCF-D001", context));
test("[HCF-D002] binding drift is rejected with ordered per-invariant findings", (context) => execute("HCF-D002", context));
test("[HCF-D003] observer evaluations remain advisory under failures", (context) => execute("HCF-D003", context));
test("[HCF-D004] structural failures disclose no candidate identity or canary", (context) => execute("HCF-D004", context));
test("[HCF-R013] all governed INC-ARCH-013 wrong-subject occurrences fail bindings", (context) => execute("HCF-R013", context));
test("[HCF-M001] canonical manifest detects integrity schema and version drift", (context) => execute("HCF-M001", context));
test("[HCF-M002] manifest projects production-owned protocol and source identities", (context) => execute("HCF-M002", context));
test("[HCF-A001] schema version missing extra and coerced fields fail closed", (context) => execute("HCF-A001", context));
test("[HCF-A002] invariant and reason removal addition and reordering fail closed", (context) => execute("HCF-A002", context));
test("[HCF-A003] identifier limit references cannot be rebound to a wider authority", (context) => execute("HCF-A003", context));
test("[HCF-A004] semantic owner paths identities and order cannot be rewritten", (context) => execute("HCF-A004", context));
test("[HCF-A005] combined self-consistent forgery cannot erase subject rejection", (context) => execute("HCF-A005", context));
test("[HCF-I001] decision identity rejects outcome reason and authority mutation", (context) => execute("HCF-I001", context));
