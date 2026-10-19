import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * DEAD-1/2/3 regression: ~321 dead exports accumulated because nothing
 * mechanically prevented exporting a symbol that no consumer ever imports.
 * The audit removed the highest-confidence ones (ToolError, GIT_*_SET, four
 * dead zod schemas). This test (a) mechanically prevents re-introduction of
 * those specific exports, and (b) runs a general scan: every top-level value
 * export (`export const/function/class X`) must be referenced by name in at
 * least one OTHER.ts file in `src/` or `test/`. Unreferenced exports are
 * reported as failures.
 */

const SRC = join(process.cwd(), "src");
const TEST = join(process.cwd(), "test");
const SCRIPTS = join(process.cwd(), "scripts");

/** This file. See the reference-surface exclusion below for why it matters. */
const SELF = new URL(import.meta.url).pathname;

// Cross-boundary consumer surface: the web UI imports backend exports
// directly. A backend export referenced only by the web UI is NOT dead, so the
// scanner must include the web-UI source or it flags cross-boundary consumers
// as false-positives.
//
// Since the monorepo assembly the web UI is the ENCLOSING root, not a sibling.
// That inverts the hazard: probing the root itself would walk this package as
// its own consumer and make every backend export look referenced. So the web
// trees are NAMED one by one, and this package's own directory is never among
// them. Each is probed at runtime and dropped when absent, so an engine-only
// checkout still scans cleanly — degrading to backend-only scope.
const WEB_UI_ROOTS: readonly string[] = (() => {
  const root = join(process.cwd(), "..");
  return ["src", "server", "shared", "tests"]
    .map((directory) => join(root, directory))
    .filter((directory) => existsSync(directory));
})();

/**
 * The enclosing root's `scripts/`, a third consumer surface that was missing
 * from this scan. It holds the web tooling and, since the monorepo assembly,
 * the harness root's tooling under `scripts/harness-root/` — both reached by
 * the one recursive walk below.
 *
 * Measured: `scripts/harness-root/merge-round.mjs` is the only consumer of
 * `DEFAULT_MERGE_LOCK_TIMEOUT_MS`, so the export read as dead here while being
 * imported and used. A universe that omits a real consumer manufactures the
 * finding, and the pressure it creates is to delete a live export or to widen
 * an allowlist — both worse than the omission.
 *
 * Probed at runtime and empty when absent, the same shape as the web-UI root
 * above, so a standalone checkout still scans cleanly.
 */
const WORKSPACE_SCRIPT_ROOTS: readonly string[] = (() => {
  const candidate = join(process.cwd(), "..", "scripts");
  return existsSync(candidate) ? [candidate] : [];
})();

// Public API entry points consumed via package.json `exports` or dynamic
// import rather than a static named import. These are allowed to have no
// static cross-file reference.
const ALLOWLIST = new Set<string>([
  "runCli", // package.json exports "." -> src/cli.ts runCli
]);

function listTsFiles(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts"] }));
  return acc;
}

/**
 * Collect TypeScript + JavaScript source files (incl. `.mjs`/`.js`) from a
 * directory tree. Used for the cross-boundary consumer surface (`scripts/`
 * and the web-UI sibling) where non-`.ts` consumers live. Excludes
 * `node_modules`, dot-dirs, and non-source assets.
 */
function listSourceFiles(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] }));
  return acc;
}

interface ExportDecl {
  name: string;
  file: string;
}

function collectValueExports(files: readonly string[]): ExportDecl[] {
  const decls: ExportDecl[] = [];
  // Match: export const X, export let X, export function X, export class X,
  // export { X, Y as Z } (capture local names X, Y).
  const patterns: RegExp[] = [
    /\bexport\s+(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu,
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu,
    /\bexport\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu,
  ];
  const reexportPattern = /\bexport\s+\{([^}]+)\}/gu;
  for (const file of files) {
    // THE DOOR. `codeWithStrings()` and not `code()`: an export's members and
    // a re-export's aliases are identifiers in real code, but a declaration
    // written inside a doc comment is prose. Quoted strings stay because a
    // name reached by string is still a reference in this tree's idiom.
    const text = readSourceView(file).codeWithStrings();
    for (const re of patterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        decls.push({ name: m[1]!, file });
      }
    }
    reexportPattern.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = reexportPattern.exec(text)) !== null) {
      const names = rm[1]!.split(",");
      for (const spec of names) {
        // "X" or "X as Y" — THE EXPORT'S NAME IS Y, NOT X.
        //
        // DRIVEN, and this was live. The previous line took the first
        // identifier, so `export { collectKnownNumeric as
        // _debugCollectKnownNumeric }` was recorded under the LOCAL name — and
        // the local name is referenced all over its own module, so the export
        // read as alive. The public name it actually publishes occurred exactly
        // ONCE in either repository: on that line. Three of the four `_debug*`
        // re-exports in `duplicate-body-detector.ts` were dead this way and the
        // scanner could not see any of them, because it was asking about a
        // symbol nobody imports by that name.
        const parts = spec.trim().split(/\s+as\s+/u);
        const exported = (parts[parts.length - 1] ?? "").trim();
        if (exported.length > 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(exported)) {
          decls.push({ name: exported, file });
        }
      }
    }
  }
  return decls;
}

function buildReferenceIndex(files: readonly string[]): Map<string, Set<string>> {
  // Map: symbol name -> set of file paths that contain a word-boundary reference.
  const index = new Map<string, Set<string>>();
  for (const file of files) {
    const text = readSourceView(file).codeWithStrings();
    // Collect all identifier-like tokens once per file.
    const tokens = new Set<string>(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? []);
    for (const tok of tokens) {
      let set = index.get(tok);
      if (set === undefined) { set = new Set(); index.set(tok, set); }
      set.add(file);
    }
  }
  return index;
}

test("dead-export-scanner: ToolError is not exported (DEAD-1 prevention)", () => {
  // Build the symbol name dynamically so this test file does not itself
  // contain the literal token (which would self-reference and mask re-introduction).
  const symbol = ["Tool", "Error"].join("");
  const errorsSrc = readSourceView(join(SRC, "kernel/errors.ts")).codeWithStrings();
  const exportRe = new RegExp(`\\bexport\\s+(?:class|const|function)\\s+${symbol}\\b`, "u");
  assert.equal(
    exportRe.test(errorsSrc),
    false,
    `${symbol} was a dead export that was removed; it must not be re-introduced in src/errors.ts`,
  );
  // And it is not referenced anywhere in src/ (it is dead).
  const srcFiles = listTsFiles(SRC);
  const tokenRe = new RegExp(`\\b${symbol}\\b`, "u");
  const refs = srcFiles.filter((f) => tokenRe.test(readSourceView(f).codeWithStrings()));
  assert.deepEqual(
    refs,
    [],
    `${symbol} must not be referenced anywhere in src/ (it is a removed dead export): ${refs.join(", ")}`,
  );
});

test("dead-export-scanner: no GIT_*_SET constants are exported (DEAD-2 prevention)", () => {
  // The audit removed dead `GIT_*_SET` exports. Re-introducing them must fail.
  const gitFiles = listTsFiles(join(SRC, "git"));
  const offenders: string[] = [];
  for (const file of gitFiles) {
    const text = readSourceView(file).codeWithStrings();
    const re = /\bexport\s+(?:const|let)\s+([A-Za-z_$][A-Za-z0-9_$]*_SET)\b/gu;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (/^GIT_/u.test(m[1]!)) offenders.push(`${file.replace(process.cwd() + "/", "")}: ${m[1]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `GIT_*_SET dead exports must not be re-introduced. Offenders: ${offenders.join(", ")}`,
  );
});

test("dead-export-scanner: every value export is referenced in at least one other file (no NEW dead exports)", () => {
  const srcFiles = listTsFiles(SRC);
  // The reference surface includes backend src/, tests, in-repo scripts (a
  // `.mjs` script may be the only consumer of an export), and the web-UI
  // sibling source (cross-boundary consumers). A backend-only checkout with
  // no web UI present degrades gracefully to backend-only scope.
  const allFiles = [
    ...srcFiles,
    ...listTsFiles(TEST),
    ...listSourceFiles(SCRIPTS),
    ...WEB_UI_ROOTS.flatMap((root) => listSourceFiles(root)),
    ...WORKSPACE_SCRIPT_ROOTS.flatMap((root) => listSourceFiles(root)),
  ];
  const decls = collectValueExports(srcFiles);

  // ── A GUARD MUST NOT BE ITS OWN WITNESS ─────────────────────────────────
  //
  // THE DEFECT THIS LINE EXISTS FOR, DRIVEN. This file is inside `test/`, so
  // it is inside its own reference surface — and it used to carry a 315-entry
  // `BASELINE_DEAD_EXPORTS` set of string literals spelling out the very
  // symbols it was asked about. The reference index counts identifiers inside
  // quoted strings, so EVERY BASELINED EXPORT WAS HELD ALIVE BY THE BASELINE
  // THAT EXEMPTED IT. Measured: with the baseline present the scan reported
  // `allChildren`'s only external reference as this file; with it removed the
  // dead set went from 0 to 124.
  //
  // So the exemption list was simultaneously the evidence that nothing needed
  // exempting — a guard agreeing with itself, in a file whose header says it
  // builds its own symbol names dynamically so it "does not itself contain the
  // literal token". That precaution was taken for ONE symbol and the same
  // mistake was made 315 times fifty lines below it.
  //
  // Excluding the file is the general repair: whatever a guard writes down
  // about a symbol is a CLAIM about that symbol, never a USE of it.
  const referenceSurface = allFiles.filter((file) => file !== SELF);
  assert.ok(
    referenceSurface.length === allFiles.length - 1,
    `this guard must be inside its own scan to be excluded from it, and ${SELF} was not found ` +
      "among the scanned files — the exclusion has silently stopped applying",
  );
  const refIndex = buildReferenceIndex(referenceSurface);
  const dead: string[] = [];
  for (const decl of decls) {
    if (ALLOWLIST.has(decl.name)) continue;
    const refs = refIndex.get(decl.name);
    const key = `${decl.name}|${decl.file.replace(process.cwd() + "/", "")}`;
    if (refs === undefined) {
      dead.push(key);
      continue;
    }
    const externalRefs = [...refs].filter((f) => f !== decl.file);
    if (externalRefs.length === 0) {
      dead.push(key);
    }
  }

  // ── THE BASELINE IS GONE, AND ITS ABSENCE IS THE POINT ──────────────────
  //
  // There was a `BASELINE_DEAD_EXPORTS` set here holding 315 entries, and the
  // assertion below was `current \ baseline === []`. Three things were wrong
  // with it, all measured:
  //
  //   * 140 of the 315 entries were MALFORMED — whole source lines pasted from
  //     a two-column listing and from a diff, quotes and column padding
  //     included ("+   'writeTestFileDurations|…'"). A key like that can never
  //     equal a computed `name|path`, so it matched nothing, ever.
  //   * those 140 could only ever land in `missingBaseline`, which was
  //     DELIBERATELY DISCARDED via `void missingBaseline` — a branch whose
  //     whole job was to notice this and whose implementation was to say
  //     nothing. The set could not fail in that direction by construction.
  //   * and the set was a hand-written universe of 315 strings, which is the
  //     defect `declared-universe.ts` exists to refuse, in a guard.
  //
  // With the reference index built over raw BYTES, `current` was **0**: every
  // one of 2,833 exports was "referenced", because a name written in any
  // comment or any string in 2,042 files counted. So the assertion was
  // `[] \ baseline === []` — VACUOUSLY TRUE, green having found nothing, the
  // exact class this session named. Over `codeWithStrings()` it is 2, and both
  // are real. The baseline is deleted rather than corrected: with the view
  // fixed and the two real findings fixed, an empty answer is an answer, and a
  // floor on the POPULATION (below) is what makes it one.
  assert.ok(
    decls.length > 0,
    "no value exports were collected at all — the DECLARATION matcher has gone blind, and a " +
      "scan with nothing to examine agrees with every claim about it",
  );
  assert.ok(
    refIndex.size > 0,
    "the reference index is empty — the token matcher has gone blind, which would report EVERY " +
      "export as dead rather than none, but is still a broken instrument and not a finding",
  );
  assert.ok(
    referenceSurface.length > srcFiles.length,
    `the reference surface (${allFiles.length}) must be wider than the declaration surface ` +
      `(${srcFiles.length}) — if the sibling roots stopped resolving, every cross-boundary ` +
      "consumer would vanish and this guard would manufacture dead exports",
  );

  // ── WHY THIS CAN NAME THE COMMENT, WHICH IS WHAT MAKES IT ACTIONABLE ─────
  //
  // A guard that says "X is dead" when a reader can plainly see the name in
  // another file gets overridden, and correctly so. `prose()` returns the
  // comments as DATA with the line each one starts on, so the refusal can say
  // *referenced only in a comment at file:line* — the difference between an
  // assertion and an argument. A stripper that merely deletes comments destroys
  // exactly the information needed to explain the finding.
  // ── THE RATCHET, AS AN EXACT SET AND NOT A SUPERSET ─────────────────────
  //
  // The entries below are exports referenced by no other file IN CODE. HOW
  // MANY there are is `BASELINE_DEAD_EXPORTS.length` and is deliberately not
  // restated in prose: a count written in a comment goes stale the moment an
  // entry is triaged away, and this one already did — it said 127 while the
  // array held 115. The array is the receipt; read it, do not paraphrase it.
  //
  // What the number is worth remembering is its HISTORY, which prose can carry
  // because it does not move: over raw bytes this scan reported ZERO dead
  // exports out of 2,833 declarations, because a name written in any comment or
  // any string in 2,041 files counted as a use — and 315 of those "uses" were
  // this file's own baseline, holding alive exactly the symbols it exempted.
  //
  // TRIAGE IS THE WORK, NOT THE BASELINE. Twelve entries have already left it
  // by being fixed rather than excused: the eleven per-module `*Registered`
  // idempotence flags under `src/shared/exposure/registrations/` and
  // `resetRegistrationFlags` beside them were module-internal state wearing the
  // `export` keyword, with zero references in code OR prose across 2,191 files
  // in both repositories. Dropping the keyword — not the declaration — turned a
  // dead public surface into private state with no behaviour to change.
  //
  // The assertion is EQUALITY, in both directions, and the difference from
  // what stood here matters:
  //
  //   * a NEW dead export fails, as before.
  //   * a baselined export that gets FIXED now ALSO fails, saying so and
  //     asking for the entry to be deleted. That direction used to be computed
  //     into `missingBaseline` and then thrown away with `void
  //     missingBaseline` — a branch whose whole purpose was to notice this and
  //     whose body was a statement that does nothing. 140 of the 315 entries
  //     were malformed whole source lines that could ONLY ever land there, so
  //     the one direction that would have reported them was the one direction
  //     deliberately silenced.
  //
  // Equality is affordable because the set is exact and this file is excluded
  // from its own reference surface, so an entry here can no longer keep its own
  // subject alive.
  const BASELINE_DEAD_EXPORTS: readonly string[] = [
    "adapterForLanguage|src/awareness/languages/index.ts",
    "allChildren|src/quality/languages/shared/tree-sitter-walker.ts",
    "assertRootPath|src/shared/git-churn.ts",
    "biasJaccard|src/safety/bias-detector.ts",
    "buildEnvironments|src/self-improving/generation-evolver.ts",
    "buildLeChatelierRecords|src/quality-packs/prevention/le-chatelier-bandaid.ts",
    "buildLineOffsets|src/quality/languages/shared/tree-sitter-walker.ts",
    "buildProposal|src/extensions/approval-workflow.ts",
    "CANONICAL_DOMAIN_HASH_ENCODING|src/integrity.ts",
    "checkDeadAfterRethrow|src/quality/checks/dead-code.ts",
    "checkDeadBranch|src/quality/checks/dead-code.ts",
    "checkDeadPrivateFunctions|src/quality/checks/dead-code.ts",
    "checkUnreachableAfterTerminator|src/quality/checks/dead-code.ts",
    "checkUnusedHeaders|src/quality/checks/unused-imports.ts",
    "CHEP_CANONICAL_PHASE_COUNTS|src/evaluation/types.ts",
    "CHEP_REPETITIONS|src/evaluation/types.ts",
    "childForField|src/quality/languages/shared/tree-sitter-walker.ts",
    "computeErrorRate|src/self-improving/learner.ts",
    "computeFalsePositiveRate|src/self-improving/learner.ts",
    "computeFisherRanking|src/awareness/fisher-ranking.ts",
    "cosineEmbeddings|src/memory/unified/unified-memory-store.ts",
    "createBiasPreventer|src/safety/bias-preventer.ts",
    "createClassifier|src/memory/unified/proactive-injector.ts",
    "createLanguageAgnosticSyntaxValidatorRegistry|src/editor/syntax-validator.ts",
    "_debugCollectFunctions|src/quality-packs/prevention/duplicate-body-detector.ts",
    "_debugCollectKnownNumeric|src/quality-packs/prevention/duplicate-body-detector.ts",
    "_debugComputeIterationBodyTokens|src/quality-packs/prevention/duplicate-body-detector.ts",
    "_debugNormalizeTokensV2|src/quality-packs/prevention/duplicate-body-detector.ts",
    "defaultFailoverConfig|src/shared/llm/failover.ts",
    "DEFAULT_LEDGER_CANONICAL_LIMITS|src/ledger-canonical.ts",
    "DEFAULT_PRIVACY_SETTINGS|src/privacy/pii-registry.ts",
    "deriveCapabilityRequirement|src/capability-negotiation.ts",
    "DIAGNOSTIC_SNAPSHOT_SCHEMA_VERSION|src/performance/diagnostic-modes.ts",
    "duplicateBodyCheck|src/quality-packs/typescript-pack.ts",
    "duplicatedLiteralsCheck|src/quality-packs/typescript-pack.ts",
    "emitTokensWithSubst|src/quality-packs/prevention/async-effect-normalizer.ts",
    "esmCjsMismatchCheck|src/quality-packs/typescript-pack.ts",
    "extractPatterns|src/self-improving/learner.ts",
    "fieldText|src/quality/languages/shared/tree-sitter-walker.ts",
    "filePathFromArgs|src/memory/tool-result-summary.ts",
    "findByType|src/quality/languages/shared/tree-sitter-walker.ts",
    "findByTypes|src/quality/languages/shared/tree-sitter-walker.ts",
    "findDescendants|src/quality/languages/shared/tree-sitter-walker.ts",
    "findingToImprovement|src/self-improving/workflow-improver.ts",
    "firstNamedChildOfTypes|src/quality/languages/shared/tree-sitter-walker.ts",
    "FORENSIC_ACTOR_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_AGENT_SCHEMA|src/forensic-contracts.ts",
    "forensicClassification|src/classification-catalog.ts",
    "FORENSIC_CORRELATION_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_ERROR_CAUSE_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_HEADER_ENTRY_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_HEADERS_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_TIMESTAMP_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_TURN_SCHEMA|src/forensic-contracts.ts",
    "FORENSIC_USAGE_SCHEMA|src/forensic-contracts.ts",
    "generateSummary|src/memory/unified/unified-tool-result-store.ts",
    "getTreeSitterParser|src/quality/languages/shared/tree-sitter-loader.ts",
    "grepPatternFromArgs|src/memory/tool-result-summary.ts",
    "initTreeSitterSyntaxValidators|src/editor/syntax-validator.ts",
    "isBandaidFamily|src/safety/bandaid-config.ts",
    "isBarrelFile|src/quality/checks/barrel-detection.ts",
    "isBiasType|src/safety/bias-config.ts",
    "isFixableCause|src/self-improving/mistake-detector.ts",
    "isKnownSourceFile|src/intelligence/language-registry.ts",
    "isLeaf|src/quality/languages/shared/tree-sitter-walker.ts",
    "isLongCommentHeuristicMarker|src/safety/bandaid-pattern-learner.ts",
    "isSourceLanguage|src/quality/config.ts",
    "isUnfixableCause|src/self-improving/mistake-detector.ts",
    "LongTaskCheckResult|src/tools/concurrent/index.ts",
    "LongTaskCheckStatus|src/tools/concurrent/index.ts",
    "LongTaskStartOptions|src/tools/concurrent/index.ts",
    "markCoveredAfterLearning|src/self-improving/learner.ts",
    "MEMORY_DOMAIN|src/memory/memory-types.ts",
    "MIGRATION_1_SQL|src/timeline/timeline-schema.ts",
    "MIGRATION_2_SQL|src/timeline/timeline-schema.ts",
    "MIGRATION_NAMES|src/timeline/timeline-schema.ts",
    "namedChildCount|src/quality/languages/shared/tree-sitter-walker.ts",
    "namedChildrenOfType|src/quality/languages/shared/tree-sitter-walker.ts",
    "novelPatterns|src/self-improving/learner.ts",
    "parseEditFragment|src/safety/bandaid-ast-detector.ts",
    "parseRequirementsRegistry|src/requirements.ts",
    "parseSseFrame|src/event-state.ts",
    "projectMcpToolsList|src/protocol-projections.ts",
    "propagateChurnToFunctions|src/shared/git-churn.ts",
    "proposeRules|src/self-improving/learner.ts",
    "readLanguageWasm|src/quality/languages/shared/tree-sitter-loader.ts",
    "removeRedundant|src/awareness/fisher-ranking.ts",
    "REQUIREMENTS_REGISTRY_IDENTITY|src/requirements.ts",
    "REQUIREMENTS_REGISTRY_ROW_SET_HASHES|src/requirements.ts",
    "REQUIREMENTS_REGISTRY_SCHEMA|src/requirements.ts",
    "_resetEmbeddingProviderForTests|src/quality-packs/prevention/embedding-provider.ts",
    "runBiasAnalysis|src/safety/bias-preventer.ts",
    "searchQueryFromArgs|src/memory/tool-result-summary.ts",
    // SENSITIVE_KEY_PARTS was here and is REMOVED, which is the ratchet
    // recording an improvement rather than an exemption: the debug redactor
    // (`src/shared/debug/debug-system.ts`) now derives its credential-noun
    // content patterns from it instead of from a hand-written regex list in
    // `bridlewise.config.json`, so the export has a real consumer.
    "signalVector|src/awareness/fisher-ranking.ts",
    "spearman|src/awareness/fisher-ranking.ts",
    "summarizeGenericResult|src/memory/tool-result-summary.ts",
    "SURFACE_ASSESSMENTS_SCHEMA|src/requirements.ts",
    "TIER_CHECK_MAP|src/quality-packs/tiers.ts",
    "TIMELINE_IDENTITY|src/timeline/timeline-types.ts",
    "TIMELINE_MIGRATIONS|src/timeline/timeline-types.ts",
    "TIMELINE_RECORD_DOMAIN|src/timeline/timeline-types.ts",
    "tokenizeSubtree|src/awareness/languages/tree-sitter-base.ts",
    "ToolSecurityError|src/tools/tool-adapter.ts",
    "UNICODE_CASE_FOLDING_GENERATOR_REVISION|src/repository-path/unicode-case-fold.generated.ts",
    "uniqueTerms|src/shared/memory/retrieval/text-utils.ts",
    "validatePath|src/editor/transactional-editor.ts",
    "validateRepositoryPathContext|src/repository-path/logical.ts",
    "validateRepositoryPathLimits|src/repository-path/logical.ts",
  ];

  // The baseline's path half is FOLD-SENSITIVE: an entry records a symbol that
  // is dead AT ITS CURRENT LOCATION, and the fold moved several owners into
  // domain folders without un-killing the symbol. Re-key each entry's path so a
  // move updates the receipt instead of manufacturing a false "no longer dead"
  // improvement. A path that still exists is kept verbatim; a path the fold
  // removed is re-resolved by basename through the module resolver. A basename
  // that is now absent or ambiguous throws — the receipt saying the entry needs
  // triage, not a silent pass.
  const BASELINE_RESOLVED: readonly string[] = BASELINE_DEAD_EXPORTS.map((entry) => {
    const sepAt = entry.indexOf("|");
    const name = entry.slice(0, sepAt);
    const rel = entry.slice(sepAt + 1);
    if (existsSync(join(process.cwd(), rel))) return entry;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    return `${name}|${engineModuleSourceRelative(base)}`;
  });

  const newlyDead = dead.filter((k) => !BASELINE_RESOLVED.includes(k)).sort();
  const noLongerDead = BASELINE_RESOLVED.filter((k) => !dead.includes(k)).sort();

  // ONE PASS, and only when there is something to explain. The first spelling
  // called this per finding, so it re-lexed all 2,042 files once per dead
  // export and the test stopped finishing — a guard nobody can afford to run
  // is a guard that gets deleted.
  const proseSightings = new Map<string, string[]>();
  if (newlyDead.length > 0) {
    const wanted = newlyDead.map((key) => [key, new RegExp(`\\b${key.split("|")[0]!}\\b`, "u")] as const);
    for (const file of referenceSurface) {
      let lines;
      try {
        lines = readSourceView(file).prose();
      } catch {
        continue;
      }
      for (const [key, token] of wanted) {
        const seen = proseSightings.get(key) ?? [];
        if (seen.length >= 3) continue;
        for (const line of lines) {
          if (!token.test(line.text)) continue;
          seen.push(`${file.replace(process.cwd() + "/", "")}:${line.line}`);
          break;
        }
        proseSightings.set(key, seen);
      }
    }
  }
  const explain = (key: string): string => {
    const sightings = proseSightings.get(key) ?? [];
    return sightings.length === 0
      ? `${key} (no mention anywhere, not even in prose)`
      : `${key} — referenced ONLY in a comment, at ${sightings.join(", ")}`;
  };

  assert.deepEqual(
    noLongerDead,
    [],
    "These exports are in the dead-export baseline and are NO LONGER dead. That is good news and " +
      "it still fails: delete them from BASELINE_DEAD_EXPORTS so the ratchet records the " +
      "improvement, or the list slowly becomes a set of claims nothing re-checks.\n" +
      noLongerDead.map((k) => `  ${k}`).join("\n"),
  );
  assert.deepEqual(
    newlyDead.sort(),
    [],
    "Dead value exports: exported, and referenced by no other file in either repository, in " +
      "CODE. Remove the export (the symbol can stay module-private) or import it somewhere.\n" +
      newlyDead.map((k) => `  ${explain(k)}`).join("\n") +
      `\n(declarations examined: ${decls.length}, reference surface: ${referenceSurface.length} files)`,
  );
});
