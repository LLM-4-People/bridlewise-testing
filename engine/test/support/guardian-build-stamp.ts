import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { readGuardianBuildStampSpec } from "../../src/filesystem/self-protection/guardian-build-stamp.ts";

/**
 * Copy the guardian's sealed build inputs — the one spec and every source it
 * names — into another harness root. Tests that build or place a guardian
 * binary in a fake root need the same inputs beside it, or the availability
 * probe refuses on an unreadable source tree before it reaches the behaviour
 * under test.
 */
export function copyGuardianSealedInputs(fromRoot: string, toRoot: string): void {
  const specRelative = ROOT_POLICY.selfProtection.buildStampSpecPath;
  const sourceDirectory = dirname(specRelative);
  mkdirSync(dirname(join(toRoot, specRelative)), { recursive: true });
  copyFileSync(join(fromRoot, specRelative), join(toRoot, specRelative));
  for (const source of readGuardianBuildStampSpec(fromRoot).sources) {
    copyFileSync(join(fromRoot, sourceDirectory, source), join(toRoot, sourceDirectory, source));
  }
}
