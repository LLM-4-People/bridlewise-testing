import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  EngineModuleResolutionError,
  engineModulePath,
  engineModulePathMatching,
  engineModuleSourceRelative,
} from "./module-resolver.ts";

test("engine module resolver: resolves a moved module by basename", () => {
  const path = engineModulePath("root-policy.ts");
  assert.ok(path.endsWith("src/kernel/root-policy.ts"), `unexpected: ${path}`);
  assert.ok(existsSync(path), "resolved path must exist");
});

test("engine module resolver: refuses an absent module", () => {
  assert.throws(
    () => engineModulePath("__definitely_not_a_module__.ts"),
    (error: unknown) =>
      error instanceof EngineModuleResolutionError && error.message.includes("does not exist"),
  );
});

test("engine module resolver: refuses an ambiguous basename and names the collisions", () => {
  assert.throws(
    () => engineModulePath("config.ts"),
    (error: unknown) =>
      error instanceof EngineModuleResolutionError &&
      error.message.includes("ambiguous") &&
      error.message.includes("kernel/config.ts"),
  );
});

test("engine module resolver: disambiguates by path fragment", () => {
  const path = engineModulePathMatching("kernel/config.ts");
  assert.ok(path.endsWith("src/kernel/config.ts"), `unexpected: ${path}`);
});

test("engine module resolver: fragment tolerates a src/ prefix and refuses ambiguity", () => {
  assert.equal(engineModulePathMatching("src/kernel/errors.ts"), engineModulePathMatching("kernel/errors.ts"));
  assert.throws(
    () => engineModulePathMatching("errors.ts"),
    (error: unknown) => error instanceof EngineModuleResolutionError && error.message.includes("ambiguous"),
  );
});

test("engine module resolver: source-relative form re-applies the src/ prefix", () => {
  assert.equal(engineModuleSourceRelative("kernel/errors.ts"), "src/kernel/errors.ts");
  assert.equal(engineModuleSourceRelative("root-policy.ts"), "src/kernel/root-policy.ts");
});

test("engine module resolver: a moved module still resolves (the whole point)", () => {
  // forensic-state.ts was folded to forensics/. A resolver rooted at the tree
  // resolves it by name regardless of the folder; the assertion pins the
  // CURRENT location only as a sanity witness, the resolution is by name.
  assert.equal(engineModuleSourceRelative("forensic-state.ts"), "src/forensics/forensic-state.ts");
});
