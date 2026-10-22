import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { analyzeArchitectureSource } from "../scripts/verification/architecture.ts";
import {
  verifyCommandEffectInventory,
  type CommandEffectSource,
} from "../scripts/tooling/verification/command-effect-inventory.ts";
import { preservedFixtureProjectionPaths } from "../scripts/tooling/verification/rejected-binary-fixture.ts";
import { verifyGovernedTypeScriptSource } from "../scripts/tooling/verification/governed-source.ts";
import { ARCHITECTURE_MANIFEST } from "../src/architecture-manifest.ts";
import {
  CommandEffectContractError,
  defineCommandEffectContract,
} from "../verification/benchmarks/shared/command-effect-contract.mjs";
import { MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS } from
  "../verification/benchmarks/coordination/migration-write-authority/author-trust-base.mjs";
import {
  SECRET_SPAN_AUTHOR_RECEIPT_COMMAND_EFFECTS,
  SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS,
} from "../verification/benchmarks/secret-spans/foundation-paths.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

import { experimentExclusion, walk } from "../scripts/verification/source-walk.ts";
import { createTempDir } from "./support/temp-dir.ts";
import { engineModuleSourceRelative } from "./support/module-resolver.ts";
import { posix } from "node:path";

// The fixtures model a module at src/hostile-effect-fixture.ts importing the
// central policy. That import specifier is FOLD-SENSITIVE: it must name the
// policy's current location relative to the fixture, so derive it from the
// resolver (the owner of where root-policy.ts lives) rather than hardcoding a
// path that breaks on every move.
const FIXTURE_MODULE_PATH = "src/hostile-effect-fixture.ts";
const centralPolicySpecifier = `./${posix.relative(
  posix.dirname(FIXTURE_MODULE_PATH),
  engineModuleSourceRelative("root-policy.ts"),
)}`;
const CENTRAL_POLICY_IMPORT = `import { ROOT_POLICY } from "${centralPolicySpecifier}";`;

function facts(source: string) {
  return analyzeArchitectureSource("src/hostile-effect-fixture.ts", source);
}

function hasGit(source: string): boolean {
  return facts(source).directEffectFacts.some((fact) =>
    fact.ownerLabel === "git-invocation" && fact.effects.includes("git")
  );
}

function governedViolations(
  source: string,
  path = "src/hostile-effect-fixture.ts",
): readonly string[] {
  const violations: string[] = [];
  verifyGovernedTypeScriptSource(path, source, violations);
  return violations;
}

test("filesystem capabilities hidden in carriers fail closed", () => {
  const fixtures = [
    `import * as fs from "node:fs";
     const operation = Math.random() > 0.5 ? fs.readFileSync : fs.writeFileSync;
     operation("fixture");`,
    `import * as fs from "node:fs";
     const operations = { write: fs.writeFileSync };
     operations.write("fixture", "x");`,
    `import * as fs from "node:fs";
     const [write] = [fs.writeFileSync];
     write("fixture", "x");`,
    `import * as fs from "node:fs";
     const name = process.argv[2];
     const { [name]: operation } = fs;
     operation("fixture");`,
    `import * as fs from "node:fs";
     const operation = () => fs.writeFileSync;
     operation()("fixture", "x");`,
  ] as const;

  for (const source of fixtures) {
    const result = facts(source);
    assert.equal(result.unmodeledEffects.some((reason) => reason.startsWith("node:fs:")), true, source);
    assert.equal(
      result.directEffectFacts.some((fact) => fact.effects.includes("filesystem-write")),
      true,
      source,
    );
  }
});

test("mutable executable aliases and shell or env wrappers conservatively expose Git", () => {
  const gitFixtures = [
    `import { spawnSync } from "node:child_process";
     let executable = process.execPath;
     executable = "git";
     spawnSync(executable, ["status"]);`,
    `import { execSync } from "node:child_process";
     execSync("true && git status");`,
    `import { execSync } from "node:child_process";
     execSync("FOO=bar git status");`,
    `import { execSync } from "node:child_process";
     execSync("/bin/sh -c 'git status'");`,
    `import { spawnSync } from "node:child_process";
     spawnSync("env", ["-u", "FOO", "git", "status"]);`,
    `import { spawnSync } from "node:child_process";
     spawnSync("/bin/sh", ["-c", "git status"]);`,
  ] as const;
  for (const source of gitFixtures) assert.equal(hasGit(source), true, source);

  const unsupported = facts(`import { execSync } from "node:child_process";
    execSync("echo $DYNAMIC_COMMAND");`);
  assert.equal(unsupported.unmodeledEffects.some((reason) =>
    reason.startsWith("node:child_process:dynamic-executable-execSync")
  ), true);
  assert.equal(unsupported.directEffectFacts.some((fact) => fact.effects.includes("git")), true);

  const splitEnvironment = facts(`import { spawnSync } from "node:child_process";
    spawnSync("env", ["-S", "git status"]);`);
  assert.equal(splitEnvironment.unmodeledEffects.some((reason) =>
    reason.startsWith("node:child_process:dynamic-executable-spawnSync")
  ), true);
  assert.equal(splitEnvironment.directEffectFacts.some((fact) => fact.effects.includes("git")), true);
});

test("plain current-Node and simple non-Git invocations stay modeled", () => {
  for (const source of [
    `import { spawnSync } from "node:child_process";
     spawnSync(process.execPath, ["--version"]);`,
    `import { execSync } from "node:child_process";
     execSync("echo ok");`,
  ]) {
    const result = facts(source);
    assert.equal(result.unmodeledEffects.length, 0, source);
    assert.equal(result.directEffectFacts.some((fact) => fact.effects.includes("git")), false, source);
  }
});

test("dynamic executable exemption belongs only to the registered pinned-process primitive x3", () => {
  const source = `import { spawnSync } from "node:child_process";
    export function runPinnedProcess(profile) { spawnSync(profile.executablePath, [], { env: {} }); }`;
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const admitted = analyzeArchitectureSource("src/process/pinned-process-internal.ts", source);
    assert.equal(admitted.unmodeledEffects.length, 0);
    assert.equal(admitted.directEffectFacts.some((fact) => fact.effects.includes("git")), false);
    const copied = analyzeArchitectureSource(`src/process/copied-${repetition}.ts`, source);
    assert.ok(copied.unmodeledEffects.includes("node:child_process:dynamic-executable-spawnSync"));
    assert.ok(copied.directEffectFacts.some((fact) => fact.effects.includes("git")));
  }
});

test("Linux O_PATH is modeled only through its exact central policy authority", () => {
  const admitted = facts(`import { constants, openSync } from "node:fs";
    ${CENTRAL_POLICY_IMPORT}
    openSync(".", ROOT_POLICY.receipts.immutableExecution.linuxPathOnlyOpenFlag |
      constants.O_DIRECTORY | constants.O_NOFOLLOW);`);
  assert.deepEqual(admitted.unmodeledEffects, []);
  assert.deepEqual(admitted.directEffectFacts, [{
    ownerLabel: "node:fs",
    effects: ["filesystem-read"],
  }]);

  const hostile = [
    `import { constants, openSync } from "node:fs";
      openSync(".", 0o10000000 | constants.O_DIRECTORY | constants.O_NOFOLLOW);`,
    `import { constants, openSync } from "node:fs";
      ${CENTRAL_POLICY_IMPORT}
      openSync(".", ROOT_POLICY.receipts.immutableExecution.fileMode |
        constants.O_DIRECTORY | constants.O_NOFOLLOW);`,
    `import { constants, openSync } from "node:fs";
      const ROOT_POLICY = { receipts: { immutableExecution: { linuxPathOnlyOpenFlag: 0o10000000 } } };
      openSync(".", ROOT_POLICY.receipts.immutableExecution.linuxPathOnlyOpenFlag |
        constants.O_DIRECTORY | constants.O_NOFOLLOW);`,
  ] as const;
  for (const source of hostile) {
    const result = facts(source);
    assert.ok(result.unmodeledEffects.includes("node:fs:api-openSync"), source);
    assert.deepEqual(result.directEffectFacts, [{
      ownerLabel: "node:fs",
      effects: ["filesystem-read", "filesystem-write"],
    }], source);
  }
});

test("build generate and check command effect contracts keep defaults read-only and mutation explicit", () => {
  for (const commandClass of ["build", "generate", "check"] as const) {
    const contract = defineCommandEffectContract({
      commandClass,
      commandId: `effect-regression/${commandClass}`,
      defaultMode: "inspect",
      modes: [
        {
          availability: "available",
          effects: ["filesystem-read", "process-status"],
          invocation: "default-or-explicit",
          name: "inspect",
          unavailableCode: undefined,
        },
        {
          availability: "blocked",
          effects: ["filesystem-read", "filesystem-write", "process-status"],
          invocation: "explicit-only",
          name: "mutate",
          unavailableCode: "mutation_authority_unavailable",
        },
      ],
    });
    const defaultMode = contract.modes.find((mode) => mode.name === contract.defaultMode)!;
    assert.equal(defaultMode.effects.includes("filesystem-write"), false);
    assert.equal(contract.modes.find((mode) => mode.name === "mutate")!.invocation, "explicit-only");
  }

  const invalidContracts = [
    {
      expectedCode: "command_mutation_mode_not_explicit",
      value: {
        commandClass: "build",
        commandId: "effect-regression/implicit-write",
        defaultMode: "write",
        modes: [{
          availability: "available",
          effects: ["filesystem-write"],
          invocation: "default-or-explicit",
          name: "write",
          unavailableCode: undefined,
        }],
      },
    },
    {
      expectedCode: "command_default_effect_mode_not_read_only",
      value: {
        commandClass: "generate",
        commandId: "effect-regression/write-default",
        defaultMode: "write",
        modes: [{
          availability: "blocked",
          effects: ["filesystem-write"],
          invocation: "explicit-only",
          name: "write",
          unavailableCode: "mutation_authority_unavailable",
        }],
      },
    },
  ] as const;
  for (const fixture of invalidContracts) {
    assert.throws(() => defineCommandEffectContract(fixture.value), (error) =>
      error instanceof CommandEffectContractError && error.code === fixture.expectedCode
    );
  }

  const actualDefault = MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.modes.find((mode) =>
    mode.name === MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.defaultMode
  )!;
  assert.equal(actualDefault.name, "derive");
  assert.equal(actualDefault.effects.includes("filesystem-write"), false);
  const actualWrite = MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.modes.find((mode) =>
    mode.name === "write"
  )!;
  assert.equal(actualWrite.invocation, "explicit-only");
  assert.equal(actualWrite.availability, "blocked");

  const builderPath =
    "verification/benchmarks/coordination/migration-write-authority/build-author-receipt.mjs";
  const builderFacts = analyzeArchitectureSource(builderPath, readFileSync(join(ROOT, builderPath), "utf8"));
  assert.equal(builderFacts.unmodeledEffects.length, 0);
  assert.equal(builderFacts.directEffectFacts.some((fact) => fact.effects.includes("filesystem-write")), false);
});

function commandContract(commandId: string, effects: readonly (
  "child-process" | "cryptography" | "filesystem-read" | "filesystem-write" | "git" | "network" |
  "process-status"
)[]) {
  return defineCommandEffectContract({
    commandClass: "check",
    commandId,
    defaultMode: "inspect",
    modes: [{
      availability: "available",
      effects: ["filesystem-read", "process-status"],
      invocation: "default-or-explicit",
      name: "inspect",
      unavailableCode: undefined,
    }, {
      availability: "blocked",
      effects,
      invocation: "explicit-only",
      name: "mutate",
      unavailableCode: "mutation_authority_unavailable",
    }],
  });
}

function commandInventory(
  sources: readonly CommandEffectSource[],
  registrations: Parameters<typeof verifyCommandEffectInventory>[0]["registrations"],
  roots = registrations.map((registration) => registration.path),
) {
  return verifyCommandEffectInventory({
    architectureCompositionRoots: roots,
    registrations,
    sources,
  });
}

test("command effect inventory closes transitive JavaScript writes and requires registration", () => {
  const sources = [{
    path: "scripts/command.ts",
    source: `import { write } from "./helper.ts";
      if (import.meta.url === new URL(process.argv[1], "file:").href) write();`,
  }, {
    path: "scripts/helper.ts",
    source: `import { writeFileSync } from "node:fs";
      export function write() { writeFileSync("result", "x"); }`,
  }] as const;
  const missing = commandInventory(sources, [], []);
  assert.ok(missing.violations.includes("command-effect-registration-missing:scripts/command.ts"));
  assert.ok(missing.violations.includes("command-effect-composition-root-missing:scripts/command.ts"));

  const complete = commandInventory(sources, [{
    contract: commandContract("fixture/transitive-write", [
      "filesystem-read", "filesystem-write", "process-status",
    ]),
    disposition: "qualified-contract",
    path: "scripts/command.ts",
  }]);
  assert.equal(complete.ok, true, complete.violations.join("\n"));
  assert.deepEqual(complete.entries[0]?.closure, ["scripts/command.ts", "scripts/helper.ts"]);
  assert.ok(complete.entries[0]?.effects.includes("filesystem-write"));
});

test("command effect inventory parses declaration mode and fails closed on parse or dynamic imports", () => {
  const declaration = commandInventory([{
    path: "src/fixture.d.ts",
    source: "export declare interface Fixture { readonly value: string }",
  }], [], []);
  assert.equal(declaration.ok, true, declaration.violations.join("\n"));

  const hostile = commandInventory([{ path: "scripts/broken.ts", source: "export const x = ;" }, {
    path: "scripts/dynamic.ts",
    source: `const target = process.argv[2];
      if (import.meta.url === new URL(process.argv[1], "file:").href) void import(target);`,
  }], [{ disposition: "blocked-unqualified", path: "scripts/dynamic.ts" }]);
  assert.ok(hostile.violations.includes("command-effect-parse:scripts/broken.ts"));
  assert.ok(hostile.violations.some((entry) => entry.includes("dynamic-import")));
});

test("command candidate discovery is independent from known roots names and registrations", () => {
  const futurePath = "future-governed-surface/arbitrary-unit.mts";
  const future = commandInventory([{
    path: futurePath,
    source: `import { writeFileSync } from "node:fs";
      writeFileSync("future-output", "x");`,
  }], [], []);
  assert.ok(future.entries.some((entry) => entry.path === futurePath &&
    entry.disposition === "missing-registration"));
  assert.ok(future.violations.includes(`command-effect-registration-missing:${futurePath}`));
  assert.ok(future.violations.includes(`command-effect-composition-root-missing:${futurePath}`));
});

test("shell shebang executable and unknown candidates are discovered independently of path x3", () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const shellPath = `future-${repetition}/arbitrary/name-without-extension`;
    const unknownPath = `elsewhere-${repetition}/opaque.command`;
    const inventory = commandInventory([{
      executable: true,
      fileKind: "regular",
      path: shellPath,
      source: "#!/bin/sh\n/usr/bin/curl https://example.invalid > artifact\n/usr/bin/sha256sum artifact\n",
    }, {
      executable: true,
      fileKind: "regular",
      path: unknownPath,
      source: "opaque executable source",
    }], [], []);
    const shell = inventory.entries.find((entry) => entry.path === shellPath);
    assert.equal(shell?.language, "shell");
    for (const effect of [
      "child-process", "cryptography", "filesystem-read", "filesystem-write", "network", "process-status",
    ] as const) assert.ok(shell?.effects.includes(effect), `${shellPath}:${effect}`);
    const unknown = inventory.entries.find((entry) => entry.path === unknownPath);
    assert.equal(unknown?.language, "unknown");
    assert.deepEqual(unknown?.effects, [
      "child-process", "cryptography", "filesystem-read", "filesystem-write", "git", "network",
      "process-status",
    ]);
    assert.ok(inventory.violations.includes(
      `command-effect-unmodeled:${unknownPath}:${unknownPath}:unknown-executable-language`,
    ));
  }
});

test("mode-unavailable candidates fail closed while nonregular vendor and binary inputs are dispositioned x3", () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const unavailable = `unclassified-${repetition}/mode-unavailable.data`;
    const inventory = commandInventory([{
      executable: "unavailable",
      fileKind: "regular",
      path: unavailable,
      source: "mode could not be observed",
    }, {
      executable: true,
      fileKind: "symlink",
      path: `links-${repetition}/command.sh`,
      source: "#!/bin/sh\nexit 0\n",
    }, {
      executable: true,
      fileKind: "nonregular",
      path: `devices-${repetition}/command.sh`,
      source: "#!/bin/sh\nexit 0\n",
    }, {
      executable: true,
      fileKind: "regular",
      path: `node_modules/pkg-${repetition}/postinstall.js`,
      source: "#!/usr/bin/env node\nprocess.exit(0);\n",
    }, {
      executable: true,
      fileKind: "regular",
      path: `vendor/pkg-${repetition}/build.sh`,
      source: "#!/bin/sh\nexit 0\n",
    }, {
      executable: true,
      fileKind: "regular",
      path: `generated-${repetition}/binary-tool`,
      source: "ELF\0binary",
    }], [], []);
    const unavailableEntry = inventory.entries.find((entry) => entry.path === unavailable);
    assert.equal(unavailableEntry?.language, "unknown");
    assert.ok(inventory.violations.includes(
      `command-effect-unmodeled:${unavailable}:${unavailable}:unknown-executable-language-mode-unavailable`,
    ));
    const dispositions = new Map(inventory.sourceDispositions.map((entry) => [entry.path, entry.disposition]));
    assert.equal(dispositions.get(`links-${repetition}/command.sh`), "excluded-nonregular");
    assert.equal(dispositions.get(`devices-${repetition}/command.sh`), "excluded-nonregular");
    assert.equal(dispositions.get(`node_modules/pkg-${repetition}/postinstall.js`), "excluded-vendor");
    assert.equal(dispositions.get(`vendor/pkg-${repetition}/build.sh`), "excluded-vendor");
    assert.equal(dispositions.get(`generated-${repetition}/binary-tool`), "excluded-generated-binary");
    for (const excludedPath of dispositions.keys()) {
      if (excludedPath === unavailable) continue;
      assert.equal(inventory.entries.some((entry) => entry.path === excludedPath), false, excludedPath);
    }
  }
});

test("Python command inventory exposes writers output temporary effects Git and default-repository effects", () => {
  const source = `
import pathlib
import subprocess
import tempfile

def main():
    pathlib.Path(".").write_text("x")
    tempfile.TemporaryDirectory()
    subprocess.run(["git", "status"])
    print("result")

if __name__ == "__main__":
    main()
`;
  const inventory = commandInventory([{ path: "verification/command.py", source }], [{
    disposition: "blocked-unqualified",
    path: "verification/command.py",
  }]);
  const entry = inventory.entries[0];
  assert.ok(entry?.effects.includes("filesystem-write"));
  assert.ok(entry?.effects.includes("child-process"));
  assert.ok(entry?.effects.includes("git"));
  assert.ok(entry?.effects.includes("process-status"));
  assert.ok(inventory.violations.some((violation) => violation.includes("python-default-repository-effect")));
});

test("qualified commands require import-safe guards and complete effect contracts", () => {
  const source = [{
    path: "scripts/unsafe.ts",
    source: `#!/usr/bin/env node
      import { writeFileSync } from "node:fs";
      writeFileSync("result", "x");`,
  }] as const;
  const inventory = commandInventory(source, [{
    contract: commandContract("fixture/unsafe", ["filesystem-read", "process-status"]),
    disposition: "qualified-contract",
    path: "scripts/unsafe.ts",
  }]);
  assert.ok(inventory.violations.includes("command-effect-import-guard-missing:scripts/unsafe.ts"));
  assert.ok(inventory.violations.includes("command-effect-contract-incomplete:scripts/unsafe.ts:filesystem-write"));
});

/** Every extension a repository command can be written in. */
const COMMAND_SOURCE_EXTENSIONS = [".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx", ".py", ".sh"];

test("repository command effects are exhaustively architecture-registered while unqualified commands stay blocked", () => {
  const sources = ["scripts", "src", "verification"].flatMap((sourceRoot) =>
    walk(join(ROOT, sourceRoot), { exts: COMMAND_SOURCE_EXTENSIONS, exclude: experimentExclusion(ROOT) })
      .map((path) => ({
        executable: (lstatSync(path).mode & 0o111) !== 0,
        fileKind: "regular" as const,
        path: relative(ROOT, path),
        source: readFileSync(path, "utf8"),
      }))
  );
  const qualified = [{
    contract: MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS,
    disposition: "qualified-contract" as const,
    path: "verification/benchmarks/coordination/migration-write-authority/build-author-receipt.mjs",
  }, {
    contract: SECRET_SPAN_AUTHOR_RECEIPT_COMMAND_EFFECTS,
    disposition: "qualified-contract" as const,
    path: "verification/benchmarks/secret-spans/build-author-receipt.mjs",
  }, {
    contract: SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS,
    disposition: "qualified-contract" as const,
    path: "verification/benchmarks/secret-spans/publish-evidence.mjs",
  }];
  const independentlyDiscoveredWitnesses = [
    "verification/benchmarks/coordination/migration-write-authority/test-contracts.mjs",
    "verification/benchmarks/coordination/migration-write-authority/test-repository-facts.mjs",
    "verification/benchmarks/secret-spans/test-qualification.mjs",
  ] as const;
  for (const witnessPath of independentlyDiscoveredWitnesses) {
    const witnessSource = sources.find((source) => source.path === witnessPath)!;
    const witness = commandInventory([witnessSource], [], []);
    assert.ok(witness.entries.some((entry) => entry.path === witnessPath &&
      entry.disposition === "missing-registration"), witnessPath);
    assert.ok(witness.violations.includes(`command-effect-composition-root-missing:${witnessPath}`), witnessPath);
  }
  const inventory = verifyCommandEffectInventory({
    architectureCompositionRoots: Object.values(ARCHITECTURE_MANIFEST.compositionRoots).flat(),
    architectureExternalCommands: ARCHITECTURE_MANIFEST.externalCommands,
    preservedFixturePaths: preservedFixtureProjectionPaths((path) => readFileSync(join(ROOT, path))),
    registrations: qualified,
    sources,
  });
  assert.equal(inventory.entries.some((entry) => entry.disposition === "missing-registration"), false);
  // The ONLY external-command findings on this tree are the declared
  // absences, each refused BY NAME (the one publication rule in
  // src/kernel/architecture-external-commands.ts) — never skipped in silence.
  const declaredAbsences = ARCHITECTURE_MANIFEST.externalCommands
    .filter((entry) => entry.publication === "not-published")
    .map((entry) => `architecture-external-command-source-not-published:${entry.path}`);
  assert.deepEqual(inventory.violations.filter((entry) =>
    entry.includes("registration") || entry.includes("composition-root") || entry.includes("external-")
  ).toSorted(), declaredAbsences.toSorted());
  // The preserved-fixture exclusion is LOAD-BEARING, asserted rather than
  // implied: the fixture projections hold executable-shaped sources (the
  // superseded benchmark's runner), and without the exclusion the census
  // above reds on them. Derive the expected population from the same fixture
  // authority the scan used — never a spelled list — so a newly retained
  // fixture changes both sides together.
  const scannedPaths = new Set(sources.map((source) => source.path));
  const expectedFixtureExclusions = preservedFixtureProjectionPaths((path) => readFileSync(join(ROOT, path)))
    .filter((path) => scannedPaths.has(path));
  assert.ok(
    expectedFixtureExclusions.length > 0,
    "no preserved-fixture projection file entered the command scan — the exclusion below proves nothing",
  );
  assert.deepEqual(
    inventory.sourceDispositions.filter((entry) => entry.disposition === "excluded-preserved-fixture")
      .map((entry) => entry.path),
    expectedFixtureExclusions.toSorted(),
  );
  for (const command of ARCHITECTURE_MANIFEST.externalCommands.filter((entry) => entry.publication === "published")) {
    assert.equal(inventory.entries.find((entry) => entry.path === command.path)?.disposition, "blocked-unqualified");
  }
  // A NOT-PUBLISHED command is the declared boundary: this tree carries no
  // source for it, so it has no inventory entry and its absence is named
  // (asserted above); a source that appears for it is refused (planted below).
  const notPublished = ARCHITECTURE_MANIFEST.externalCommands.filter((entry) => entry.publication === "not-published");
  for (const command of notPublished) {
    assert.equal(scannedPaths.has(command.path), false, `${command.path} is declared not-published but the tree carries it`);
  }
  if (notPublished.length > 0) {
    const planted = verifyCommandEffectInventory({
      architectureCompositionRoots: [],
      architectureExternalCommands: [notPublished[0]!],
      registrations: [],
      sources: [{ path: notPublished[0]!.path, source: "print('present')\n" }],
    });
    assert.ok(
      planted.violations.includes(`architecture-external-command-source-unexpectedly-published:${notPublished[0]!.path}`),
      "a not-published command whose source appears is not refused",
    );
  }
  for (const registration of qualified) {
    assert.equal(inventory.entries.find((entry) => entry.path === registration.path)?.disposition, "qualified-contract");
  }
  for (const blockedTestCommand of independentlyDiscoveredWitnesses) {
    assert.equal(inventory.entries.find((entry) => entry.path === blockedTestCommand)?.disposition,
      "blocked-unqualified", blockedTestCommand);
  }

  const external = ARCHITECTURE_MANIFEST.externalCommands[0]!;
  const original = sources.find((source) => source.path === external.path)!;
  const drifted = verifyCommandEffectInventory({
    architectureCompositionRoots: [],
    architectureExternalCommands: [external],
    registrations: [],
    sources: [{ ...original, source: `${original.source}\n` }],
  });
  assert.ok(drifted.violations.includes(`architecture-external-command-source-hash-drift:${external.path}`));
  const effectDrift = verifyCommandEffectInventory({
    architectureCompositionRoots: [],
    architectureExternalCommands: [{ ...external, effects: [] }],
    registrations: [],
    sources: [original],
  });
  assert.ok(effectDrift.violations.includes(`command-effect-external-effects-drift:${external.path}`));
});

test("secret qualification commands are import-safe and reject write legacy and unknown modes", async () => {
  const commandPaths = [
    "verification/benchmarks/secret-spans/build-author-receipt.mjs",
    "verification/benchmarks/secret-spans/publish-evidence.mjs",
  ] as const;
  const moduleUrls = commandPaths.map((commandPath) => new URL(`../${commandPath}`, import.meta.url).href);
  const workingTree = createTempDir("secret-command-import-");
  try {
    const before = emptyTreeIdentity(workingTree);
    const imported = spawnSync(process.execPath, [
      "--input-type=module", "--eval",
      `const results = [];
       for (const moduleUrl of ${JSON.stringify(moduleUrls)}) {
         const captured = { stdout: "", stderr: "", error: null };
         const originalStdoutWrite = process.stdout.write;
         const originalStderrWrite = process.stderr.write;
         process.stdout.write = (chunk) => { captured.stdout += String(chunk); return true; };
         process.stderr.write = (chunk) => { captured.stderr += String(chunk); return true; };
         try {
           await import(moduleUrl);
         } catch (error) {
           captured.error = String(error && error.stack ? error.stack : error);
         } finally {
           process.stdout.write = originalStdoutWrite;
           process.stderr.write = originalStderrWrite;
         }
         results.push(captured);
       }
       process.stdout.write(JSON.stringify(results));`,
    ], { cwd: workingTree, encoding: "utf8", env: {}, shell: false });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stderr, "");
    const results = JSON.parse(imported.stdout) as readonly Readonly<{
      stdout: string;
      stderr: string;
      error: string | null;
    }>[];
    assert.equal(results.length, moduleUrls.length);
    for (const [index, result] of results.entries()) {
      assert.equal(result.error, null, commandPaths[index]);
      assert.equal(result.stdout, "", commandPaths[index]);
      assert.equal(result.stderr, "", commandPaths[index]);
    }
    assert.deepEqual(emptyTreeIdentity(workingTree), before);
  } finally {
    rmSync(workingTree, { force: true, recursive: true });
  }

  const expectations = [
    [commandPaths[0], ["--effect-mode=write"], "production_migration_write_authority_unavailable"],
    [commandPaths[0], ["--write"], "command_effect_arguments_invalid"],
    [commandPaths[0], ["--effect-mode=legacy"], "command_effect_mode_unknown"],
    [commandPaths[1], ["--effect-mode=write"], "production_migration_write_authority_unavailable"],
    [commandPaths[1], ["--write"], "command_effect_arguments_invalid"],
    [commandPaths[1], ["--effect-mode=legacy"], "command_effect_mode_unknown"],
  ] as const;
  await Promise.all(expectations.map(async ([commandPath, argumentsList, code]) => {
    const result = await runCommandExpectingFailure(join(ROOT, commandPath), argumentsList);
    assert.equal(result.status, 1, commandPath);
    assert.equal(result.stdout, "", commandPath);
    assert.equal(JSON.parse(result.stderr).code, code, commandPath);
  }));
});

function runCommandExpectingFailure(
  commandPath: string,
  argumentsList: readonly string[],
): Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [commandPath, ...argumentsList], {
      env: {}, shell: false, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (status) => resolvePromise(Object.freeze({ status, stdout, stderr })));
  });
}

test("Reflect.apply admits only proven pure intrinsics with prior receiver validation", () => {
  const admitted = governedViolations(`
    import { types } from "node:util";
    function requiredGetter(owner: object, property: PropertyKey): (this: unknown) => unknown {
      const getter = Object.getOwnPropertyDescriptor(owner, property)?.get;
      if (!getter) throw new Error(String(property));
      return getter;
    }
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    const getter = requiredGetter(prototype, "byteLength");
    export function inspect(input: unknown): number {
      if (!types.isUint8Array(input)) throw new Error("invalid");
      return Reflect.apply(getter, input, []) as number;
    }
  `);
  assert.equal(admitted.some((entry) => entry.includes("Reflect.apply")), false, admitted.join("\n"));

  const hostile = [
    `import { types } from "node:util";
      const target = (value: unknown) => value;
      export function inspect(input: unknown) {
        if (!types.isUint8Array(input)) throw new Error("invalid");
        return Reflect.apply(target, input, []);
      }`,
    `import { types } from "node:util";
      export function inspect(target: Function, input: unknown) {
        if (!types.isUint8Array(input)) throw new Error("invalid");
        return Reflect.apply(target, input, []);
      }`,
    `function requiredGetter(owner: object, property: PropertyKey): (this: unknown) => unknown {
        const getter = Object.getOwnPropertyDescriptor(owner, property)?.get;
        if (!getter) throw new Error(String(property));
        return getter;
      }
      const getter = requiredGetter(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");
      export function inspect(input: unknown) { return Reflect.apply(getter, input, []); }`,
    `import { types } from "node:util";
      function forged(owner: object, property: PropertyKey): (this: unknown) => unknown {
        const getter = Object.getOwnPropertyDescriptor(owner, property)?.get;
        console.log("effect");
        if (!getter) throw new Error(String(property));
        return getter;
      }
      const getter = forged(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");
      export function inspect(input: unknown) {
        if (!types.isUint8Array(input)) throw new Error("invalid");
        return Reflect.apply(getter, input, []);
      }`,
    `import { types } from "node:util";
      function requiredGetter(owner: object, property: PropertyKey): (this: unknown) => unknown {
        const getter = Object.getOwnPropertyDescriptor(owner, property)?.get;
        if (!getter) throw new Error(String(property));
        return getter;
      }
      const getter = requiredGetter(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");
      export function inspect(input: unknown) {
        const result = Reflect.apply(getter, input, []);
        if (!types.isUint8Array(input)) throw new Error("invalid");
        return result;
      }`,
  ] as const;
  for (const source of hostile) {
    const violations = governedViolations(source);
    assert.ok(violations.includes("production-effect-api:hostile-effect-fixture.ts:Reflect.apply"), source);
  }
});

test("only exact direct read-only qualified process version capabilities are admitted", () => {
  const admitted = governedViolations(`
    export function qualifiedRuntimeIdentity(): readonly [string, string] {
      return [process.versions.unicode, process.versions.icu];
    }
  `, "src/runtime-capabilities.ts");
  assert.equal(admitted.some((entry) => entry.startsWith("process-member-")), false, admitted.join("\n"));

  const hostile = [
    `void process.versions.unicode;`,
    `const versions = process.versions; void versions.unicode;`,
    `const processAlias = process; void processAlias.versions.unicode;`,
    `void globalThis.process.versions.unicode;`,
    `void process.versions["unicode"];`,
    `const key = String(Date.now()); void process.versions[key];`,
    `void process.versions.v8;`,
    `void process.versions;`,
    `process.versions.unicode = "forged";`,
    `process.versions.unicode++;`,
    `delete process.versions.unicode;`,
    `process.versions.unicode();`,
    "process.versions.unicode`forged`;",
    `new process.versions.unicode();`,
  ] as const;
  for (const [index, source] of hostile.entries()) {
    const path = index === 0 ? "src/hostile-effect-fixture.ts" : "src/runtime-capabilities.ts";
    const violations = governedViolations(source, path);
    assert.ok(violations.some((entry) => entry.startsWith("process-member-")), source);
  }
});

function emptyTreeIdentity(root: string) {
  const stats = lstatSync(root, { bigint: true });
  return {
    entries: readdirSync(root).toSorted(),
    device: stats.dev.toString(10),
    inode: stats.ino.toString(10),
    links: stats.nlink.toString(10),
    mode: stats.mode.toString(8),
    size: stats.size.toString(10),
    modifiedNanoseconds: stats.mtimeNs.toString(10),
    changedNanoseconds: stats.ctimeNs.toString(10),
  };
}
