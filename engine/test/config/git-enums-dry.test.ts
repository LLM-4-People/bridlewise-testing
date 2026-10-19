import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { parseImportSpecifiers } from "../support/source-scan.ts";
import { engineModulePath } from "../support/module-resolver.ts";

/**
 * INVARIANT #72: git enums (GIT_TRANSPORTS, GIT_AUTH_METHODS, etc.) must be
 * imported from the canonical owner `src/git/git-port.ts` into
 * `src/config-contracts.ts` and must NOT be redefined there. DRY: one
 * authoritative owner per concept; the config schema consumes the port's
 * enums rather than duplicating them.
 *
 * The shared git-enum set is derived DYNAMICALLY from the consumer's import
 * statement — every name `config-contracts.ts` imports from `git/git-port`
 * IS a shared enum that must (a) be defined by the canonical owner and
 * (b) not be redefined by the consumer. A newly imported enum is
 * automatically covered (deny-by-default); no hand-maintained mirror that
 * would silently miss a newly shared enum.
 */

const CONFIG_CONTRACTS_PATH = engineModulePath("config-contracts.ts");
const GIT_PORT_PATH = join(process.cwd(), "src", "git", "git-port.ts");

// Derive the shared git-enum set from what config-contracts actually imports
// from the canonical owner. The names a consumer imports ARE the shared
// contract — a newly imported name is auto-covered, a dropped name stops
// being checked.
const SHARED_GIT_ENUMS = parseImportSpecifiers(readFileSync(CONFIG_CONTRACTS_PATH, "utf8"), "git/git-port");

test("GitEnums: config-contracts imports git enums from git-port", () => {
  const source = readFileSync(CONFIG_CONTRACTS_PATH, "utf8");
  assert.ok(
    /from\s+"\.\.?\/git\/git-port\.ts"/.test(source),
    "config-contracts.ts must import from git/git-port.ts",
  );
  // Non-empty guard: a failed parse must not make the contract vacuously pass.
  assert.ok(SHARED_GIT_ENUMS.length > 0, "config-contracts.ts must import at least one git enum from git-port");
  for (const name of SHARED_GIT_ENUMS) {
    const importPattern = new RegExp(`\\b${name}\\b`);
    assert.ok(
      importPattern.test(source),
      `config-contracts.ts must reference '${name}' (via import from git-port)`,
    );
  }
});

test("GitEnums: git enums are NOT redefined in config-contracts", () => {
  const source = readFileSync(CONFIG_CONTRACTS_PATH, "utf8");
  for (const name of SHARED_GIT_ENUMS) {
    // A redefinition would look like `export const GIT_TRANSPORTS =...` or
    // `const GIT_TRANSPORTS = deepFreeze(...)` — anything that declares the
    // enum locally rather than importing it. The import statement itself is
    // allowed; a `const NAME =` declaration is not.
    const redefinitionPattern = new RegExp(
      `(?:export\\s+)?const\\s+${name}\\s*=`,
    );
    assert.ok(
      !redefinitionPattern.test(source),
      `config-contracts.ts must NOT redefine '${name}' (must import from git-port)`,
    );
  }
});

test("GitEnums: git-port is the canonical owner and defines every shared enum", () => {
  const source = readFileSync(GIT_PORT_PATH, "utf8");
  for (const name of SHARED_GIT_ENUMS) {
    const definitionPattern = new RegExp(`export\\s+const\\s+${name}\\s*=`);
    assert.ok(
      definitionPattern.test(source),
      `git-port.ts must define and export '${name}'`,
    );
  }
});
