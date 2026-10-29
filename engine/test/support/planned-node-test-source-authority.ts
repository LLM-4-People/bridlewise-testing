import { readFileSync } from "node:fs";
import { join } from "node:path";

import { deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { FOUNDATION_CASCADE_TEST_WORKER_PATH } from "./foundation-cascade-test-catalog.ts";
import { REPOSITORY_PATH_TEST_WORKER_PATH } from "./repository-path-test-catalog.ts";

export const PLANNED_NODE_TEST_SOURCE_AUTHORITY = deepFreeze({
  shared: {
    executor: {
      role: "shared-executor",
      path: "scripts/tooling/planned-node-test.ts",
      byteLength: 4577,
      sha256: "224fd2ed4141519862c83b2375932766d418723c3f58017143c247a3dbe22f4f",
    },
    evidenceExecutor: {
      role: "evidence-executor",
      path: "scripts/tooling/planned-node-test-evidence.ts",
      byteLength: 22_797,
      sha256: "7a46367c35f4a714973a449021bccd115000956eb396684e5ef7b909731472f1",
    },
  },
  suites: {
    foundationCascade: {
      worker: {
        role: "worker",
        path: FOUNDATION_CASCADE_TEST_WORKER_PATH,
        byteLength: 2_286,
        sha256: "66d152de7c33e6c15057f0bef44e138f7912f415bd5aa1e8622a7277378c6aa0",
      },
      catalog: {
        role: "catalog",
        path: "test/support/foundation-cascade-test-catalog.ts",
        byteLength: 21_174,
        sha256: "d9e76b8b315dc3b3a027168f4c588caacef89ec7c449ad987946af3209e42179",
      },
    },
    repositoryPath: {
      worker: {
        role: "worker",
        path: REPOSITORY_PATH_TEST_WORKER_PATH,
        byteLength: 2_365,
        sha256: "0602bbd8a57c1a2cd3b3ae3514ce022d22e435da55b43d3f1b641da5fb8c47d1",
      },
      catalog: {
        role: "catalog",
        path: "test/support/repository-path-test-catalog.ts",
        byteLength: 3131,
        sha256: "1527bba4f76bad40a723f2bc1a7b0a05b4fd5d8ae01e15fef1004c238d984fc0",
      },
      oracle: {
        role: "domain-oracle",
        path: "test/support/repository-path-test-oracles.ts",
        byteLength: 31_689,
        sha256: "093aa7c205ae58e66eb84a8d0d2665b3f067f3b0dba5d2a4882791684d38a850",
      },
    },
  },
} as const);

type SourcePin = Readonly<{ role: string; path: string; byteLength: number; sha256: string }>;

/**
 * The REGENERATION PATH for the planned-node-test source byte-pins. Each pin
 * (`byteLength` + `sha256`) is a fold-sensitive fact about the named source or
 * test file; a fold that re-touches one invalidates it. The pins were
 * hand-authored, which is the defect: a pin with no owner-side regeneration
 * path rots on every move. This walks the SAME authority structure and
 * recomputes each pin from the CURRENT bytes of the file at `path` (read from
 * `root`), so re-deriving after a change is one call, never a hand-edit. The
 * recorded `path` is the semantic identity; only the byte measurements are
 * recomputed. The return preserves the authority's nesting (`shared`,
 * `suites.<name>.<slot>`) so a caller can diff or rewrite it shape-for-shape.
 */
export function recomputePlannedNodeTestSourcePins(root: string): Readonly<{
  shared: Readonly<Record<string, SourcePin>>;
  suites: Readonly<Record<string, Readonly<Record<string, SourcePin>>>>;
}> {
  const pin = (entry: SourcePin): SourcePin => {
    const bytes = readFileSync(join(root, entry.path));
    return deepFreeze({
      role: entry.role,
      path: entry.path,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    });
  };
  const shared = Object.fromEntries(
    Object.entries(PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared).map(([slot, entry]) => [slot, pin(entry)]),
  );
  const suites = Object.fromEntries(
    Object.entries(PLANNED_NODE_TEST_SOURCE_AUTHORITY.suites).map(([suite, slots]) => [
      suite,
      Object.fromEntries(Object.entries(slots).map(([slot, entry]) => [slot, pin(entry)])),
    ]),
  );
  return deepFreeze({ shared, suites });
}
