import {
  createTestInventory,
  createTestInventoryEntry,
  type TestInventory,
  type TestInventoryEntry,
} from "../../scripts/test-inventory.ts";
import {
  buildTestSurfaceScope,
  createTestSurfaceDispositionManifest,
  type TestSurfaceScope,
} from "../../scripts/verification/test-surface.ts";

export type CanonicalNodeTestInventoryFixture = Readonly<{
  entry: TestInventoryEntry;
  inventory: TestInventory;
  scope: TestSurfaceScope;
}>;

export function createCanonicalNodeTestInventoryFixture(input: Readonly<{
  sourceId: string;
  sourceHash: string;
  name: string;
}>): CanonicalNodeTestInventoryFixture {
  const scope = buildTestSurfaceScope(
    [input.sourceId],
    createTestSurfaceDispositionManifest([{
      path: input.sourceId,
      language: "javascript-typescript",
      disposition: "canonical-node-test",
      rationale: "Canonical Node test-inventory fixture generated through the production contract.",
      evidenceLinks: [],
      blocksFullRepositoryClaim: false,
    }]),
  );
  const entry = createTestInventoryEntry(input.sourceId, input.sourceHash, input.name);
  return Object.freeze({ entry, inventory: createTestInventory(scope, [entry]), scope });
}
