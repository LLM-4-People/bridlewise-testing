import assert from "node:assert/strict";
import { join, relative } from "node:path";
import test from "node:test";

import { findCatchBlocks, type CatchBlock } from "../../scripts/verification/catch-blocks.ts";
import { readSourceView, sourceViewOf } from "../../scripts/verification/source-view.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * No empty catch blocks in engine source, scripts or verification code. The
 * classification is the ONE shared catch classifier
 * (`scripts/verification/catch-blocks.ts`), which the unhandled-error guard and
 * the web guard also use: a body that is blank, comment-only, or only no-op
 * statements (`void e;`, a bare `e;`) is empty.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "scripts", "verification"];

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function emptyCatches(content: string): readonly CatchBlock[] {
  return findCatchBlocks(sourceViewOf(content, "fixture.ts")).filter((block) => block.verdict === "empty");
}

test("prevention: no empty catch blocks (comment-only) in source files", () => {
  const findings: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of listTsFiles(join(ROOT, dir))) {
      for (const block of findCatchBlocks(readSourceView(file))) {
        if (block.verdict === "empty") findings.push(`  ${relative(ROOT, file)}:${block.line}`);
      }
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} empty/effectively-empty catch block(s) in source files:\n${findings.join("\n")}\n` +
        `Fix: each catch block must contain actual error-handling code (rethrow as a typed error, return, route through a central handler, or use the caught value). ` +
        `A comment-only catch body and a 'void e;' (evaluate-and-discard) body are PROHIBITED (prevention rule: no-empty-catch-blocks). ` +
        `Use bestEffort/bestEffortAsync from src/shared/best-effort.ts for cleanup/observer/fallback operations.`,
    );
  }
});

test("prevention scanner: catches catch block with only a comment (mutant A)", () => {
  assert.equal(emptyCatches("try { op(); } catch { /* ignore */ }").length, 1, "comment-only catch must be detected");
});

test("prevention scanner: catches catch block with only a block comment (mutant B)", () => {
  assert.equal(emptyCatches("try { op(); } catch { /* best-effort cleanup */ }").length, 1, "comment-only catch must be detected");
});

test("prevention scanner: catches catch block with only a line comment (mutant C)", () => {
  assert.equal(emptyCatches("try {\n  op();\n} catch {\n  // ignore this\n}").length, 1, "comment-only catch must be detected");
});

test("prevention scanner: allows catch with actual code (no false positive)", () => {
  assert.equal(emptyCatches('try { op(); } catch (e) { if (e.code === "ENOENT") return; throw e; }').length, 0, "catch with code must not be flagged");
});

test("prevention scanner: allows catch with return statement (no false positive)", () => {
  assert.equal(emptyCatches("try { op(); } catch { return false; }").length, 0, "catch with return must not be flagged");
});

test("prevention scanner: catches `void e;` gaming (mutant F)", () => {
  assert.equal(emptyCatches("try { op(); } catch (e) { void e; }").length, 1, "void e; catch must be detected as effectively empty");
});

test("prevention scanner: catches `void extractErrorMessage(error);` gaming (mutant G)", () => {
  assert.equal(emptyCatches("try { op(); } catch (error) { void extractErrorMessage(error); }").length, 1, "void <pure-fn>; catch must be detected as effectively empty");
});

test("prevention scanner: catches bare identifier `e;` gaming (mutant H)", () => {
  assert.equal(emptyCatches("try { op(); } catch (e) { e; }").length, 1, "bare identifier catch must be detected as effectively empty");
});

test("prevention scanner: allows catch with console.warn (no false positive)", () => {
  assert.equal(emptyCatches('try { op(); } catch (e) { console.warn("op failed", e.message); }').length, 0, "catch with console.warn must not be flagged");
});

test("prevention scanner: an empty promise handler and a catch keyword inside a string or comment", () => {
  assert.equal(emptyCatches("p.catch(() => { /* ignore */ });").length, 1, "an empty .catch handler block is empty");
  assert.equal(emptyCatches('const s = "try {} catch {}"; // catch { }').length, 0, "catch inside a string or comment is not code");
});
