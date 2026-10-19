import { readFileSync } from "node:fs";
import { spec } from "node:test/reporters";

import { executeInventoryTestRun } from "../../../scripts/tooling/inventory-test-run.ts";
import { parseTestInventoryDocument } from "../../../scripts/test-inventory.ts";
import { canonicalJson } from "../../../src/kernel/integrity.ts";

const root = process.argv[2];
const inventoryPath = process.argv[3];
if (!root || !inventoryPath || process.argv.length !== 4) {
  throw new Error("Usage: coverage-runner ROOT INVENTORY");
}
const inventory = parseTestInventoryDocument(JSON.parse(readFileSync(inventoryPath, "utf8")) as unknown);
const reporter = spec();
let reportByteLength = 0;
reporter.on("data", (chunk: Buffer | string) => {
  reportByteLength += Buffer.byteLength(chunk);
});
const accounting = await executeInventoryTestRun(root, inventory, {
  coverage: true,
  reporter,
});
process.stdout.write(`${canonicalJson({ ...accounting, reportByteLength })}\n`);
process.exitCode = accounting.passed ? 0 : 1;
