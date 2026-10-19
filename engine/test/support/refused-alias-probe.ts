/**
 * Runs INSIDE a private mount namespace where `REFUSED_ALIAS_VIEW` is a bind
 * mount of `HOME` (see `refused-paths.test.ts`): every path below is spelled
 * through the alias, which no `realpath` removes. Prints one verdict per case
 * — the compiler's refusal code — so the parent asserts what the floor did.
 */
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { HarnessError } from "../../src/kernel/errors.ts";
import { compileSelfProtectionConfigToSpec } from "../../src/filesystem/self-protection/guardian-binary.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG, parseSelfProtectionConfig } from "../../src/filesystem/self-protection/self-protection-config.ts";
import { resolveLocation } from "../../src/filesystem/path-identity.ts";
import { emptyKeepOutFacts } from "./keep-out-facts.ts";

const EMPTY_KEEP_OUT = emptyKeepOutFacts();

const home = process.env.HOME!;
const view = process.env.REFUSED_ALIAS_VIEW!;
const harness = process.env.REFUSED_ALIAS_HARNESS!;
const project = process.env.REFUSED_ALIAS_PROJECT!;
const alias = (path: string): string => join(view, relative(home, path));

function verdict(allow: readonly Readonly<{ path: string; access: readonly string[] }>[], harnessRoot = harness, projectRoot = project): string {
  try {
    compileSelfProtectionConfigToSpec(
      parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true, tempDir: projectRoot, additionalAllowRules: allow }),
      harnessRoot, projectRoot, "/usr/bin/node", EMPTY_KEEP_OUT,
    );
    return "compiled";
  } catch (error) {
    return error instanceof HarnessError ? error.code : String(error);
  }
}

const identity = (path: string): string => { const s = statSync(path); return `${s.dev}:${s.ino}`; };
const ssh = join(home, ".ssh");

// A harness and a project that live INSIDE the aliased home, so the alias names them too.
const innerHarness = join(home, "harness");
mkdirSync(join(innerHarness, "src"), { recursive: true });
writeFileSync(join(innerHarness, "src", "owned.ts"), "export const owned = 1;\n");
const innerProject = join(home, "work");
mkdirSync(join(innerProject, "bin"), { recursive: true });

process.stdout.write(JSON.stringify({
  sameIdentity: String(identity(alias(ssh)) === identity(ssh)),
  // The defect this closes: the resolved spellings do not compare equal.
  stringCompareSeesNothing: String(!resolveLocation(alias(ssh)).startsWith(resolveLocation(ssh))),
  aliasOfSsh: verdict([{ path: alias(ssh), access: ["READ_FILE", "READ_DIR"] }]),
  aliasOfHome: verdict([{ path: view, access: ["READ_FILE"] }]),
  aliasOfProtectedSrc: verdict([{ path: alias(join(innerHarness, "src")), access: ["READ_FILE"] }], innerHarness),
  aliasOfProjectExecutable: verdict([{ path: alias(join(innerProject, "bin")), access: ["READ_FILE", "EXECUTE"] }], harness, innerProject),
}));
