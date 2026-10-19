import { canonicalHash, deepFreeze } from "../../src/kernel/integrity.ts";
import { HANDOFF_PROTOCOL_AUTHORITY } from "../../src/modules/tasks-agents/index.ts";
import type { PlannedNodeTestCheck, PlannedNodeTestFamily } from "../../scripts/tooling/planned-node-test.ts";

export const HANDOFF_CONTINUITY_TEST_CATALOG = deepFreeze([
  { id: "HCF-S001", name: "non-finite numbers fail at every structural position" },
  { id: "HCF-S002", name: "proxies and accessors are rejected without executing caller code" },
  { id: "HCF-S003", name: "hidden inherited cyclic and non-JSON structures fail closed" },
  { id: "HCF-L001", name: "configured identifier and root structural ceilings are exact" },
  { id: "HCF-C001", name: "assignment compilation and inspection bind immutable authority bytes" },
  { id: "HCF-D001", name: "matching handoff is held with unavailable nominal authorities" },
  { id: "HCF-D002", name: "binding drift is rejected with ordered per-invariant findings" },
  { id: "HCF-D003", name: "observer evaluations remain advisory under failures" },
  { id: "HCF-D004", name: "structural failures disclose no candidate identity or canary" },
  { id: "HCF-R013", name: "all governed INC-ARCH-013 wrong-subject occurrences fail bindings" },
  { id: "HCF-M001", name: "canonical manifest detects integrity schema and version drift" },
  { id: "HCF-M002", name: "manifest projects production-owned protocol and source identities" },
  { id: "HCF-A001", name: "schema version missing extra and coerced fields fail closed" },
  { id: "HCF-A002", name: "invariant and reason removal addition and reordering fail closed" },
  { id: "HCF-A003", name: "identifier limit references cannot be rebound to a wider authority" },
  { id: "HCF-A004", name: "semantic owner paths identities and order cannot be rewritten" },
  { id: "HCF-A005", name: "combined self-consistent forgery cannot erase subject rejection" },
  { id: "HCF-I001", name: "decision identity rejects outcome reason and authority mutation" },
] as const);

export const HANDOFF_CONTINUITY_TEST_ASSERTION_ID = "handoff-continuity-domain-oracle" as const;
export const HANDOFF_CONTINUITY_TEST_WORKER_PATH =
  "test/support/handoff-continuity-hostile-worker.test.ts" as const;
export type HandoffContinuityTestId = typeof HANDOFF_CONTINUITY_TEST_CATALOG[number]["id"];
export type HandoffContinuityOracle = (id: HandoffContinuityTestId, check: PlannedNodeTestCheck) => void;

export const HANDOFF_CONTINUITY_TEST_DECLARATION_IDENTITY = canonicalHash({
  catalog: HANDOFF_CONTINUITY_TEST_CATALOG,
  assertionId: HANDOFF_CONTINUITY_TEST_ASSERTION_ID,
  protocol: {
    manifestSchemaVersion: HANDOFF_PROTOCOL_AUTHORITY.manifestSchemaVersion,
    currentProtocolVersion: HANDOFF_PROTOCOL_AUTHORITY.currentProtocolVersion,
  },
});

export function createHandoffContinuityPlannedCatalog(
  oracle: HandoffContinuityOracle,
): readonly PlannedNodeTestFamily<HandoffContinuityTestId>[] {
  return deepFreeze(HANDOFF_CONTINUITY_TEST_CATALOG.map((entry) => ({
    ...entry,
    assertionPlan: [{ id: HANDOFF_CONTINUITY_TEST_ASSERTION_ID, checks: 1 }],
    run: (invoke) => invoke(HANDOFF_CONTINUITY_TEST_ASSERTION_ID, (check) => oracle(entry.id, check)),
  })));
}
