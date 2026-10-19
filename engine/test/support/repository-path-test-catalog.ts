import { canonicalHash, deepFreeze } from "../../src/kernel/integrity.ts";
import type {
  PlannedNodeTestCheck,
  PlannedNodeTestFamily,
} from "../../scripts/tooling/planned-node-test.ts";

export const REPOSITORY_PATH_TEST_CATALOG = deepFreeze([
  { id: "RPA-U001", name: "official source and generated authority identities" },
  { id: "RPA-U002", name: "all Unicode 17 C plus F mappings and production Q keys" },
  { id: "RPA-U003", name: "all Unicode 17 normalization conformance assertions" },
  { id: "RPA-U004", name: "source generated table and manifest mutations fail closed" },
  { id: "RPA-G001", name: "vendored Git source license and upstream test identities" },
  { id: "RPA-G002", name: "exact Git NTFS aliases cover every fallback width and boundary" },
  { id: "RPA-L001", name: "scalar syntax normalization and exhaustive surrogate classes" },
  { id: "RPA-L002", name: "Win32 characters trailing aliases and reserved devices" },
  { id: "RPA-L003", name: "exact Git and strict-profile contextual symlink aliases" },
  { id: "RPA-L004", name: "all configurable bounds at below exact and above limits" },
  { id: "RPA-S001", name: "trap-free set snapshot rejects hostile structures" },
  { id: "RPA-S002", name: "ordinal-only collision evidence and canary-safe errors" },
  { id: "RPA-B001", name: "runtime path authorities reject direct import and cast forgery" },
  { id: "RPA-C001", name: "central config owns actual bounds under closed profile" },
  { id: "RPA-E001", name: "generator defaults read-only and write remains unavailable" },
] as const);

export const REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS = deepFreeze({
  caseFoldingEntries: 1_585,
  normalizationRows: 20_034,
  normalizationAssertionsPerRow: 5,
  normalizationAssertions: 100_170,
  terminalHighSurrogates: 1_024,
  terminalLowSurrogates: 1_024,
  validSurrogatePairs: 1_048_576,
} as const);

export const REPOSITORY_PATH_TEST_ASSERTION_ID = "repository-path-domain-oracle" as const;
export const REPOSITORY_PATH_TEST_WORKER_PATH =
  "test/support/repository-path-hostile-worker.test.ts" as const;
export const REPOSITORY_PATH_TEST_IDS = deepFreeze(REPOSITORY_PATH_TEST_CATALOG.map((entry) => entry.id));
export type RepositoryPathTestId = typeof REPOSITORY_PATH_TEST_CATALOG[number]["id"];
export type RepositoryPathOracle = (
  id: RepositoryPathTestId,
  check: PlannedNodeTestCheck,
) => void;

/** Static declaration identity only; bound evidence also includes callback/oracle source bytes. */
export const REPOSITORY_PATH_TEST_DECLARATION_IDENTITY = canonicalHash({
  catalog: REPOSITORY_PATH_TEST_CATALOG,
  assertionId: REPOSITORY_PATH_TEST_ASSERTION_ID,
  corpus: REPOSITORY_PATH_OFFICIAL_CORPUS_EXPECTATIONS,
});

export function createRepositoryPathPlannedCatalog(
  oracle: RepositoryPathOracle,
): readonly PlannedNodeTestFamily<RepositoryPathTestId>[] {
  return deepFreeze(REPOSITORY_PATH_TEST_CATALOG.map((entry) => ({
    ...entry,
    assertionPlan: [{ id: REPOSITORY_PATH_TEST_ASSERTION_ID, checks: 1 }],
    run: (invoke) => invoke(REPOSITORY_PATH_TEST_ASSERTION_ID, (check) => oracle(entry.id, check)),
  })));
}
