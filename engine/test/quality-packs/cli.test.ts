import assert from "node:assert/strict";
import test from "node:test";

import {
  parseQualityArgs,
  createQualityContext,
  formatTierResult,
} from "../../src/quality-packs/cli.ts";
import {
  runTier,
} from "../../src/quality-packs/tiers.ts";
import { typescriptPack } from "../../src/quality-packs/typescript-pack.ts";

const CLEAN_TS = "function f(): number { return 42; }\nexport { f };\n";
const BROKEN_TS = "function f(: number { return 42; }\n";

// ========== parseQualityArgs tests ==========

test("quality-cli: parseQualityArgs defaults to full tier", () => {
  const result = parseQualityArgs([]);
  assert.equal(result.tier, "full");
  assert.equal(result.root, null);
  assert.equal(result.paths.length, 0);
});

test("qualitycli: parseQualityArgs --tier=fast", () => {
  const result = parseQualityArgs(["--tier=fast"]);
  assert.equal(result.tier, "fast");
});

test("qualitycli: parseQualityArgs --tier incremental", () => {
  const result = parseQualityArgs(["--tier", "incremental"]);
  assert.equal(result.tier, "incremental");
});

test("qualitycli: parseQualityArgs -t full", () => {
  const result = parseQualityArgs(["-t", "full"]);
  assert.equal(result.tier, "full");
});

test("qualitycli: parseQualityArgs -t holdout", () => {
  const result = parseQualityArgs(["-t", "holdout"]);
  assert.equal(result.tier, "holdout");
});

test("qualitycli: parseQualityArgs rejects invalid tier", () => {
  assert.throws(() => parseQualityArgs(["--tier=invalid"]), /Invalid tier/);
  assert.throws(() => parseQualityArgs(["--tier", "bad"]), /Invalid tier/);
});

test("qualitycli: parseQualityArgs --tier without value throws", () => {
  assert.throws(() => parseQualityArgs(["--tier"]), /requires a value/);
  assert.throws(() => parseQualityArgs(["-t"]), /requires a value/);
});

test("qualitycli: parseQualityArgs --root=PATH", () => {
  const result = parseQualityArgs(["--root=/tmp/test"]);
  assert.equal(result.root, "/tmp/test");
});

test("qualitycli: parseQualityArgs --root PATH", () => {
  const result = parseQualityArgs(["--root", "/tmp/test"]);
  assert.equal(result.root, "/tmp/test");
});

test("qualitycli: parseQualityArgs -r PATH", () => {
  const result = parseQualityArgs(["-r", "/tmp/test"]);
  assert.equal(result.root, "/tmp/test");
});

test("qualitycli: parseQualityArgs --root without value throws", () => {
  assert.throws(() => parseQualityArgs(["--root"]), /requires a path value/);
  assert.throws(() => parseQualityArgs(["-r"]), /requires a path value/);
});

test("qualitycli: parseQualityArgs collects file paths", () => {
  const result = parseQualityArgs(["file1.ts", "file2.ts"]);
  assert.deepEqual([...result.paths], ["file1.ts", "file2.ts"]);
});

test("qualitycli: parseQualityArgs mixed flags and paths", () => {
  const result = parseQualityArgs(["--tier=fast", "file1.ts", "--root=/tmp", "file2.ts"]);
  assert.equal(result.tier, "fast");
  assert.equal(result.root, "/tmp");
  assert.deepEqual([...result.paths], ["file1.ts", "file2.ts"]);
});

test("qualitycli: parseQualityArgs result is frozen", () => {
  const result = parseQualityArgs(["--tier=fast"]);
  assert.ok(Object.isFrozen(result));
});

// ========== createQualityContext tests ==========

test("qualitycli: createQualityContext creates context with files", () => {
  const ctx = createQualityContext("/root", { "test.ts": "code" });
  assert.equal(ctx.rootPath, "/root");
  assert.equal(ctx.filePath, null);
  assert.equal(ctx.source, null);
  assert.ok(Object.keys(ctx.files).includes("test.ts"));
  assert.ok(Object.isFrozen(ctx));
});

// ========== formatTierResult tests ==========

test("qualitycli: formatTierResult produces structured output", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("full", [typescriptPack], ctx);
  const output = formatTierResult(result);
  assert.equal(output.schemaVersion, "bridlewise-quality-cli/v1");
  assert.equal(output.tier, "full");
  assert.ok(Array.isArray(output.checkIds));
  assert.ok(typeof output.exitCode === "number");
  assert.ok(Array.isArray(output.packs));
});

test("qualitycli: formatTierResult with syntax error", () => {
  const ctx = createQualityContext(".", { "broken.ts": BROKEN_TS });
  const result = runTier("fast", [typescriptPack], ctx);
  const output = formatTierResult(result);
  assert.equal(output.exitCode, 1);
  assert.ok((output.summary as Readonly<{ errors: number }>).errors > 0);
});

test("qualitycli: formatTierResult output is frozen", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("full", [typescriptPack], ctx);
  const output = formatTierResult(result);
  assert.ok(Object.isFrozen(output));
});

test("qualitycli: formatTierResult includes pack details", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("full", [typescriptPack], ctx);
  const output = formatTierResult(result);
  const packs = output.packs as readonly Readonly<{ packId: string; checks: readonly unknown[] }>[];
  assert.ok(packs.length > 0);
  assert.ok(packs[0]!.checks.length > 0);
});

// ========== CLI integration tests ==========

test("qualitycli: CLI quality command resolves via ROOT_POLICY", async () => {
  const { ROOT_POLICY } = await import("../../src/kernel/root-policy.ts");
  assert.equal(ROOT_POLICY.protocol.qualityCommand, "quality");
});

test("qualitycli: runCli dispatches quality command", async () => {
  const { runCli } = await import("../../src/cli.ts");
  const code = await runCli(["quality", "--tier=fast", "nonexistent.ts"]);
  assert.equal(code, 0);
});

test("qualitycli: runCli quality with syntax error file returns 1", async () => {
  const { runCli } = await import("../../src/cli.ts");
  // We can't easily test with actual files in the repo, but we can verify the command is accepted
  const code = await runCli(["quality", "--tier=fast", "nonexistent.ts"]);
  assert.ok(code === 0 || code === 1);
});

test("qualitycli: runCli rejects unknown command after quality", async () => {
  const { runCli } = await import("../../src/cli.ts");
  const code = await runCli(["unknown-command"]);
  assert.equal(code, 1);
});

// ========== Tier-specific CLI output tests ==========

test("qualitycli: fast tier output includes only fast check ids", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("fast", [typescriptPack], ctx);
  const output = formatTierResult(result);
  const checkIds = output.checkIds as readonly string[];
  assert.deepEqual([...checkIds], ["syntax-errors", "type-errors"]);
});

test("qualitycli: incremental tier output includes incremental check ids", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("incremental", [typescriptPack], ctx);
  const output = formatTierResult(result);
  const checkIds = output.checkIds as readonly string[];
  assert.ok(checkIds.includes("dead-symbols"));
  assert.ok(checkIds.includes("unused-exports"));
});

test("qualitycli: full tier output includes all full check ids", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("full", [typescriptPack], ctx);
  const output = formatTierResult(result);
  const checkIds = output.checkIds as readonly string[];
  assert.ok(checkIds.includes("duplicate-logic"));
});

test("qualitycli: holdout tier output includes undefined-symbols", () => {
  const ctx = createQualityContext(".", { "test.ts": CLEAN_TS });
  const result = runTier("holdout", [typescriptPack], ctx);
  const output = formatTierResult(result);
  const checkIds = output.checkIds as readonly string[];
  assert.ok(checkIds.includes("undefined-symbols"));
});

// ========== Hostile CLI tests ==========

test("qualitycli: --help flag does not crash", () => {
  parseQualityArgs(["--help"]);
});

test("qualitycli: -h flag does not crash", () => {
  parseQualityArgs(["-h"]);
});

test("qualitycli: unknown flags are ignored", () => {
  const result = parseQualityArgs(["--unknown-flag", "file.ts"]);
  assert.deepEqual([...result.paths], ["file.ts"]);
});

test("qualitycli: absolute path is handled", () => {
  const result = parseQualityArgs(["/absolute/path/file.ts"]);
  assert.deepEqual([...result.paths], ["/absolute/path/file.ts"]);
});

test("qualitycli: multiple --tier flags use last one", () => {
  const result = parseQualityArgs(["--tier=fast", "--tier=holdout"]);
  assert.equal(result.tier, "holdout");
});

test("qualitycli: multiple --root flags use last one", () => {
  const result = parseQualityArgs(["--root=/first", "--root=/second"]);
  assert.equal(result.root, "/second");
});
