import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { CENTRAL_ERROR_HANDLERS, findCatchBlocks, type CatchBlock } from "../../scripts/verification/catch-blocks.ts";
import { readSourceView, sourceViewOf } from "../../scripts/verification/source-view.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * Mechanical prevention: a centralized debug/error system must be enforced
 * everywhere. All errors, warnings, and audit events go through one
 * centralized system.
 *
 * Test 1 — UNHANDLED errors: every catch in src/ (a `try/catch`, or an inline
 * `.catch(...)` handler block) that has code must handle what it caught. The
 * rule is the ONE shared catch classifier (`scripts/verification/catch-blocks.ts`),
 * also used by the empty-catch guards in both repositories. A body is handled
 * when it throws, returns, CALLS a central handler (`CENTRAL_ERROR_HANDLERS`:
 * `handleError`, `reportBestEffortFailure`, `bestEffort`/`bestEffortAsync`,
 * `auditEvent`, and the web's `webHandleError`/`webWarn`/`webAuditEvent` —
 * console output is not central), or uses the caught binding (discarding it,
 * `void e` or a bare `e;`, is not a use). It is read through the code view, so a handler NAMED in a
 * comment or a string, or a binding mentioned only inside a string, is not handling.
 *
 * Test 2 — `console.log`/`console.error` in source: direct console calls
 * in production code bypass the central system. The only legitimate
 * `console.*` calls are inside `src/shared/debug/debug-system.ts` (the
 * console sink and terminal fallback) and the CLI entry.
 */

const ROOT = process.cwd();
const SRC_ROOT = join(ROOT, "src");

// Files where `console.*` is legitimate (user-facing output or the debug sink).
const CONSOLE_ALLOWED_FILES = new Set<string>([
  join("src", "shared", "debug", "debug-system.ts"),
  join("src", "cli.ts"),
]);

/**
 * Files where a direct `process.{stdout,stderr}.write` is legitimate.
 *
 * A CLI is a TERMINAL PROGRAM: its standard streams ARE its user interface, so
 * progress and machine-readable reports belong there and nowhere else. Every
 * file below is a command entry point or a progress callback the command
 * injects. A PRODUCTION module has no such excuse — its warning/error belongs
 * to the central debug owner, whose warn/error levels are never suppressed.
 *
 * This list is the allow-list, not the rule: a new file appears here only with
 * a reason, and the scan below refuses the write otherwise.
 */
const STREAM_ALLOWED_FILES = new Set<string>([
  join("src", "cli.ts"), // the harness CLI entry point
  join("src", "quality-packs", "cli.ts"), // the quality-pack command's report
  join("src", "shared", "debug", "debug-system.ts"), // the central owner's own sinks/fallback
  join("src", "shared", "run-cpu.ts"), // the run-CPU measurement command's JSON report
  join("src", "workflow", "checkout-setup.ts"), // setup progress for a CLI run
  join("src", "workflow", "flake-cli.ts"), // flake-reproduction command output
  join("src", "workflow", "forge", "projector", "realm-child.ts"), // the sealed realm's process: its one answer to its parent is stdout, its refusal stderr
  join("src", "workflow", "harness-commands.ts"), // harness subcommand reports and progress
  join("src", "workflow", "promotion", "promoter-home.ts"), // forwards a promoted process's stderr
  join("src", "workflow", "slot-cli.ts"), // slot command output
  join("src", "workflow", "workspace-cli.ts"), // workspace command output
]);

// ── File discovery ────────────────────────────────────────────────────────

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function allSrcFiles(): string[] {
  return listTsFiles(SRC_ROOT);
}

function blocksOf(content: string): readonly CatchBlock[] {
  return findCatchBlocks(sourceViewOf(content, "fixture.ts"));
}

// ── Test 1: no unhandled errors ───────────────────────────────────────────

test("prevention: no unhandled errors (catch without central system routing) in src/ files", () => {
  const findings: string[] = [];
  for (const file of allSrcFiles()) {
    for (const block of findCatchBlocks(readSourceView(file))) {
      if (block.verdict !== "unhandled") continue;
      findings.push(
        `  ${relative(ROOT, file)}:${block.line} — ${block.form === "promise" ? ".catch handler" : "catch block"} does not handle what it caught:\n` +
        `    body: ${block.excerpt}\n` +
        `    Fix: rethrow a typed error, return, use the caught value, or call a central handler (${CENTRAL_ERROR_HANDLERS.join(", ")}). ` +
        `Silently catching an error and running unrelated code is an unhandled error (prevention rule: no-unhandled-errors).`,
      );
    }
  }
  if (findings.length > 0) {
    assert.fail(`Found ${findings.length} unhandled error(s) in catch blocks in src/:\n${findings.join("\n")}`);
  }
});

// ── Test 1b: the memory subsystem's stricter rule (the former memory B2) ──
//
// A memory read or write that fails and answers `null`/`[]` looks exactly
// like "nothing remembered": the loss is invisible. So in the memory
// subsystems a BARE catch (nothing bound) must throw or call a central
// handler — returning a fallback alone is not enough there. Same reading as
// every other guard (the ONE classifier), a stricter policy on `handledBy`
// (a2-correctness §6: the rule was lost when the guards merged).

const MEMORY_SUBSYSTEMS = [join("src", "memory"), join("src", "shared", "memory")];

function memoryRuleViolations(blocks: readonly CatchBlock[]): readonly CatchBlock[] {
  return blocks.filter((block) => block.binding === null && block.verdict === "handled" && block.handledBy !== "throw" && block.handledBy !== "handler");
}

test("prevention: a bare catch in the memory subsystems throws or calls a central handler", () => {
  const findings: string[] = [];
  let scanned = 0;
  for (const file of allSrcFiles()) {
    const path = relative(ROOT, file);
    if (!MEMORY_SUBSYSTEMS.some((dir) => path.startsWith(`${dir}/`))) continue;
    scanned += 1;
    for (const block of memoryRuleViolations(findCatchBlocks(readSourceView(file)))) {
      findings.push(`  ${path}:${block.line} — a bare catch that only ${block.handledBy === "return" ? "returns a fallback" : "continues"}: ${block.excerpt}`);
    }
  }
  assert.ok(scanned > 10, `liveness: the memory subsystems must be scanned (${scanned} files)`);
  assert.deepEqual(findings, [], `Memory failures must not look like an empty memory. Throw a typed error or call handleError/bestEffort (prevention rule: no-unhandled-errors, memory):\n${findings.join("\n")}`);
});

test("prevention scanner: the memory rule refuses a bare fallback and admits a handler or a throw", () => {
  assert.equal(memoryRuleViolations(blocksOf("try { op(); } catch { return null; }")).length, 1);
  assert.equal(memoryRuleViolations(blocksOf("try { op(); } catch { return []; }")).length, 1);
  assert.equal(memoryRuleViolations(blocksOf('try { op(); } catch { handleError(new InputError("x", "c"), { module: "memory", operation: "o" }); return null; }')).length, 0);
  assert.equal(memoryRuleViolations(blocksOf('try { op(); } catch { throw new InputError("x", "c"); }')).length, 0);
  assert.equal(memoryRuleViolations(blocksOf("try { op(); } catch (e) { return fallback(e); }")).length, 0, "a bound, used error is out of this rule's scope");
});

// ── Test 2: no direct console.log/console.error in src/ (except owners) ──

test("prevention: no direct console.log/console.error in src/ outside the debug system owners", () => {
  const findings: string[] = [];
  for (const file of allSrcFiles()) {
    const relPath = relative(ROOT, file);
    if (CONSOLE_ALLOWED_FILES.has(relPath)) continue;
    const view = readSourceView(file);
    const lines = view.codeWithStrings().split("\n");
    for (const match of view.code().matchAll(/\bconsole\.(log|error|warn|info|debug)\s*\(/gu)) {
      const lineNum = view.lineAt(match.index);
      findings.push(`  ${relPath}:${lineNum}: ${lines[lineNum - 1]!.trim()}`);
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} direct console.* call(s) in src/ outside the debug system owners:\n${findings.join("\n")}\n` +
        `Fix: route through debugLog/auditEvent/handleError (src/shared/debug/debug-system.ts) or bestEffort (src/shared/best-effort.ts). ` +
        `Direct console calls bypass the central debug/error system (prevention rule: no-direct-console).`,
    );
  }
});

// ── Test 2b: no direct stdout/stderr writes in production engine modules ──
//
// The engine's console guard above reads `console.*`; the web server has its
// own `process.{stderr,stdout}.write` guard. That left a hole between them: a
// production module could write straight to stderr and no guard in either
// jurisdiction saw it (`unified-embeddings.ts` wrote its unavailable warning
// that way, invisible to both). The same source-scan owner now knows both
// spellings.

function directStreamWriteFindings(relPath: string, source: string): string[] {
  if (STREAM_ALLOWED_FILES.has(relPath)) return [];
  const view = sourceViewOf(source, relPath);
  const lines = view.codeWithStrings().split("\n");
  return [...view.code().matchAll(/\bprocess\.(stderr|stdout)\.write\s*\(/gu)].map((match) =>
    `  ${relPath}:${view.lineAt(match.index)}: ${lines[view.lineAt(match.index) - 1]!.trim()}`);
}

test("prevention: no direct process.stdout/stderr.write in production engine modules", () => {
  const findings: string[] = [];
  let scanned = 0;
  for (const file of allSrcFiles()) {
    scanned += 1;
    findings.push(...directStreamWriteFindings(relative(ROOT, file), readFileSync(file, "utf8")));
  }
  assert.ok(scanned > 100, `liveness: the engine source tree must be scanned (${scanned} files)`);
  assert.deepEqual(
    findings,
    [],
    `Found ${findings.length} direct process stream write(s) outside a CLI owner:\n${findings.join("\n")}\n` +
      `Fix: route through debugLog/handleError (warn and error are never suppressed), or add the file to STREAM_ALLOWED_FILES with its reason if it is a command's user-facing output.`,
  );
});

test("prevention scanner: the stream-write rule catches a production module and admits a CLI", () => {
  // The mutation: the exact shape the guard exists for — a warning written
  // straight to stderr from a module no central owner sees.
  const findings = directStreamWriteFindings(
    join("src", "memory", "unified", "fixture.ts"),
    "process.stderr.write(`unavailable\\n`);\n",
  );
  assert.equal(findings.length, 1, "the production module's direct write is a finding");
  assert.match(findings[0]!, /^  src\/memory\/unified\/fixture\.ts:1: process\.stderr\.write\(/u);
  assert.deepEqual(
    directStreamWriteFindings(join("src", "cli.ts"), "process.stderr.write(`unavailable\\n`);\n"),
    [],
    "the CLI entry point owns its terminal output",
  );
});

// ── Mutant tests: the scanner must catch violations ──────────────────────

function verdictOf(content: string): CatchBlock["verdict"] {
  const blocks = blocksOf(content);
  assert.equal(blocks.length, 1, "exactly one catch in the fixture");
  return blocks[0]!.verdict;
}

test("prevention scanner: catches swallowed error — catch with code but error unused (mutant A)", () => {
  assert.equal(verdictOf("try { op(); } catch (e) { doSomething(); }"), "unhandled", "catch with unrelated code is unhandled");
});

test("prevention scanner: catches swallowed error — catch with no var and no handler (mutant B)", () => {
  assert.equal(verdictOf("try { op(); } catch { doSomething(); }"), "unhandled", "catch with no var and unrelated code is unhandled");
});

test("prevention scanner: allows catch with handleError (no false positive)", () => {
  assert.equal(verdictOf('try { op(); } catch (e) { handleError(e, { module: "m", operation: "o" }); }'), "handled");
});

test("prevention scanner: allows catch with bestEffort (no false positive)", () => {
  assert.equal(verdictOf("try { cleanup(); } catch { bestEffort(() => fallback()); }"), "handled");
});

test("prevention scanner: allows catch with throw/rethrow (no false positive)", () => {
  assert.equal(verdictOf('try { op(); } catch { throw new InputError("bad", "code"); }'), "handled");
});

test("prevention scanner: allows catch with return (no false positive)", () => {
  assert.equal(verdictOf("try { op(); } catch { return null; }"), "handled");
});

test("prevention scanner: console output is not a central handler; the web's central handlers are (a2-design M3)", () => {
  // Printing bypasses the one logging system: a catch that only prints is
  // unhandled (using the caught value is still a use).
  assert.equal(verdictOf('try { op(); } catch { console.warn("op failed"); }'), "unhandled");
  assert.equal(verdictOf('try { op(); } catch { console.error("op failed"); }'), "unhandled");
  assert.equal(verdictOf('try { op(); } catch { process.emitWarning("op failed"); }'), "unhandled");
  assert.equal(verdictOf('try { op(); } catch (e) { console.warn("op failed", e.message); }'), "handled", "the caught value is used");
  for (const handler of ["webHandleError", "webWarn", "webAuditEvent"]) {
    assert.equal(verdictOf(`try { op(); } catch { ${handler}("m", "op failed"); }`), "handled", handler);
  }
});

test("prevention scanner: discarding the caught value (`void e`, a bare `e;`) is never a use (a2-correctness §6)", () => {
  assert.equal(verdictOf("try { op(); } catch (e) { void e; unrelated(); }"), "unhandled");
  assert.equal(verdictOf("try { op(); } catch (e) {\n  void e\n  cleanup()\n}"), "unhandled", "the ASI form");
  assert.equal(verdictOf("try { op(); } catch (e) { void (e); unrelated(); }"), "unhandled");
  assert.equal(verdictOf("try { op(); } catch (e) { void e.message; unrelated(); }"), "unhandled");
  assert.equal(verdictOf("try { op(); } catch (e) { e; unrelated(); }"), "unhandled");
  assert.equal(verdictOf("try { op(); } catch (e) {\n  record(\n    e\n  );\n}"), "handled", "a use split across lines is a use");
  assert.equal(verdictOf("try { op(); } catch (e) { const m = e; record(m); }"), "handled");
});

test("prevention scanner: a binding or handler named only in a string or comment is not handling (mutant C)", () => {
  // The shared classifier reads the code view, so the former accepted false
  // negative (a string containing the variable name) is now refused.
  assert.equal(verdictOf('try { op(); } catch (e) { log("caught e"); }'), "unhandled");
  assert.equal(verdictOf('try { op(); } catch { log("handleError"); /* bestEffort() */ }'), "unhandled");
  assert.equal(verdictOf("try { op(); } catch (e) { log(`caught ${e.message}`); }"), "handled", "a template substitution is real use");
});

test("prevention scanner: hostile — deeply nested catch with handler (no false positive)", () => {
  const content = `try {
    op();
  } catch (e) {
    if (e.code === "ENOENT") {
      handleError(e, { module: "m", operation: "stat" });
      return;
    }
    throw e;
  }`;
  assert.equal(verdictOf(content), "handled", "nested catch with handleError+throw is proper");
});

test("prevention scanner: fixed central reporter is handling, unrelated callbacks remain refused", () => {
  for (const operation of ["reportBestEffortFailure", "unrelatedCallback"]) {
    assert.equal(verdictOf(`try { op(); } catch { ${operation}(); }`), operation === "reportBestEffortFailure" ? "handled" : "unhandled");
  }
});

test("prevention scanner: rejecting the enclosing promise passes the error on, like throw", () => {
  assert.equal(verdictOf("new Promise((resolve, reject) => { try { op(); } catch { reject(new InputError(\"bad\", \"code\")); } });"), "handled");
  assert.equal(verdictOf("try { op(); } catch { rejected(); }"), "unhandled", "a name that merely starts with reject is not a rejection");
});

test("prevention scanner: promise handlers are classified like catch blocks", () => {
  assert.equal(verdictOf("p.catch(() => { state.status = 1; });"), "unhandled");
  assert.equal(verdictOf("p.catch((error) => { record(error); });"), "handled");
  assert.equal(verdictOf("p.catch(() => { reportBestEffortFailure(); });"), "handled");
});
