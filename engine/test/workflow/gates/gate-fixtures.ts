/**
 * Fixtures the gate tests share: a reuse-key document for a planted tree
 * (fixed file bytes, fixed probes), so a plan can be built without a checkout.
 */
import { gateKeyDocument, type GateKeyDocument } from "../../../src/workflow/gates/key.ts";
import { catalogueDigest } from "../../../src/workflow/gates/plan.ts";

/** The key of `treeId` with planted toolchain and config files. */
export function plantedKey(treeId: string, files: Readonly<Record<string, string>> = {}): GateKeyDocument {
  const defaults: Readonly<Record<string, string>> = {
    ".nvmrc": "24.20.0\n",
    "package-lock.json": "{\"lockfileVersion\":3}\n",
    "engine/package-lock.json": "{\"lockfileVersion\":3}\n",
    "engine/bridlewise.config.json": "{}\n",
  };
  return gateKeyDocument({
    treeId,
    catalogueDigest: catalogueDigest(),
    read: (path) => files[path] ?? defaults[path] ?? null,
    node: "v24.20.0",
    runnerImage: "ubuntu24/20261020.1",
    probes: { cpuModel: "planted CPU", cgroupV2: true, landlock: true, userNamespaces: true, cpuCounters: false },
  });
}
