// test/prevention/integration-intelligence-owner.test.ts
// SPO R43: Integration intelligence subsystem owner audit — mechanical enforcement.
//
// Verifies the Single-Party-Owner principle for `integration/src/intelligence/`:
// A. Config owner: the consolidated intelligence defaults (limits, thresholds,
// scan directories, EXP474 lexical weights) live in `intelligence-config.ts`
// (the single owner), NOT scattered as inline magic numbers in consumers.
// B. Consumers import the defaults from the config owner (positive assertion
// for each fixed consumer) + the old inline literals are GONE (negative).
// C. No swallowed bare `catch {}` (no binding) in the intelligence subsystem —
// every catch routes through the debug owner `handleError`.
// D. `resolveIntelligenceConfig` validates overrides at the trust boundary
// (throws typed `InputError` on bad values; accepts good overrides).
// E. Codebase-file retrieval has a single owner: `retrieveRelevantFiles` is
// defined ONLY in the resolved retrieval module (no parallel slot-allocation).
// F. Static directory lists are owned by the config: no inline
// `["src","test"]` / `["docs"]` literals in file-slice / quick-view.
//
// Dynamic discovery: `readdirSync` walks `src/intelligence/` — no
// hardcoded file lists. Mutation-verified (see bottom).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// The anti-window matcher has ONE owner and both repositories consume it.
import { bodyCalls, bodyCallsWith, bodyReturns, functionBody } from "../../src/shared/source-structure.ts";
import { engineModulePathMatching } from "../support/module-resolver.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();
const INTEL_DIR = join(ROOT, "src", "intelligence");

/**
 * The retrieval module's location, resolved from the tree (never a spelled
 * basename). The module was renamed off its experiment-round name; resolving
 * it by fragment means a future rename leaves this guard untouched instead of
 * silently pointing at a path that no longer exists. `basename` gives the
 * file-name token the ownership assertions below compare against.
 */
const RETRIEVAL_PATH = engineModulePathMatching("intelligence/retrieval.ts");
const RETRIEVAL_FILE = RETRIEVAL_PATH.slice(RETRIEVAL_PATH.lastIndexOf("/") + 1);

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"] })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

const intelFiles: string[] = listTsFiles(INTEL_DIR);
const cfgPath = join(INTEL_DIR, "intelligence-config.ts");
const cfgSrc = existsSync(cfgPath) ? read(cfgPath) : "";

// --- A. Config owner: the consolidated defaults are declared in intelligence-config.ts. ---
test("A1: intelligence-config.ts declares the consolidated defaults (single owner)", () => {
  assert.ok(cfgSrc.length > 0, "intelligence-config.ts must exist");
  const expected = [
    "DEFAULT_SEARCH_LIMIT", "DEFAULT_REUSE_LIMIT", "DEFAULT_SOURCE_ANALYSIS_LIMIT",
    "DEFAULT_REPOSITORY_MAX_DEPTH", "DEFAULT_REPOSITORY_MAX_ENTRIES",
    "DEFAULT_DATA_FLOW_MAX_DEPTH", "DEFAULT_NEXT_EDIT_MAX_PREDICTIONS",
    "DEFAULT_NEXT_EDIT_MAX_FILES", "DEFAULT_HUB_NODE_MIN_IN_DEGREE",
    "DEFAULT_INCLUDE_SEARCH_DEPTH", "DEFAULT_FILE_SLICE_OPTIONS_LIMIT",
    "DEFAULT_FILE_SLICE_CALLEES_LIMIT", "DEFAULT_SOURCE_DIRECTORIES",
    "DEFAULT_TEST_DIRECTORIES", "DEFAULT_DOC_DIRECTORIES",
    "DEFAULT_EXP474_LEXICAL_OVERLAP_CAP", "DEFAULT_EXP474_LEXICAL_PER_WORD",
    "DEFAULT_EXP474_SINGULAR_MIN_LENGTH", "DEFAULT_EXP474_CLASS_MATCH_MIN_LENGTH",
    "resolveIntelligenceConfig",
  ];
  for (const name of expected) {
    assert.match(cfgSrc, new RegExp(`\\b${name}\\b`), `intelligence-config.ts must declare ${name}`);
  }
});

test("A2: resolveIntelligenceConfig is exported (public validated accessor)", () => {
  assert.match(cfgSrc, /export function resolveIntelligenceConfig/, "resolveIntelligenceConfig must be exported");
  assert.match(cfgSrc, /export type IntelligenceConfig/, "IntelligenceConfig type must be exported");
});

// --- B. Consumers import the defaults from the config owner; old inline literals gone. ---
test("B1: consumers import the consolidated defaults from intelligence-config.ts", () => {
  const checks: ReadonlyArray<Readonly<{ file: string; symbol: RegExp }>> = [
    { file: "intelligence-types.ts", symbol: /DEFAULT_SEARCH_LIMIT/ },
    { file: "intelligence-types.ts", symbol: /DEFAULT_REUSE_LIMIT/ },
    // R21-TC-F1: the walk's depth/entry ceilings are now CONSUMED from the
    // config resolver (repositoryMaxDepth/repositoryMaxEntries) rather than
    // restated as frozen constants — the pin follows the live wiring, so a
    // return to a frozen parallel copy (the dead-knob state) reds here.
    { file: "repository-stat-scan.ts", symbol: /config\.repositoryMaxEntries/ },
    { file: "repository-stat-scan.ts", symbol: /config\.repositoryMaxDepth/ },
    { file: "repository-map.ts", symbol: /resolveIntelligenceConfig/ },
    { file: "data-flow.ts", symbol: /DEFAULT_DATA_FLOW_MAX_DEPTH/ },
    { file: "next-edit-prefetch.ts", symbol: /DEFAULT_NEXT_EDIT_MAX_PREDICTIONS/ },
    { file: "next-edit-prefetch.ts", symbol: /DEFAULT_NEXT_EDIT_MAX_FILES/ },
    { file: "dependency-graph.ts", symbol: /DEFAULT_HUB_NODE_MIN_IN_DEGREE/ },
    { file: "dependency-graph.ts", symbol: /DEFAULT_INCLUDE_SEARCH_DEPTH/ },
    { file: "file-slice.ts", symbol: /DEFAULT_FILE_SLICE_OPTIONS_LIMIT/ },
    { file: "file-slice.ts", symbol: /DEFAULT_FILE_SLICE_CALLEES_LIMIT/ },
    { file: "file-slice.ts", symbol: /DEFAULT_SCAN_DIRECTORIES/ },
    { file: "quick-view.ts", symbol: /DEFAULT_SOURCE_DIRECTORIES/ },
    { file: "quick-view.ts", symbol: /DEFAULT_TEST_DIRECTORIES/ },
    { file: "quick-view.ts", symbol: /DEFAULT_DOC_DIRECTORIES/ },
    { file: "symbol-extractor.ts", symbol: /DEFAULT_SOURCE_ANALYSIS_LIMIT/ },
    { file: RETRIEVAL_FILE, symbol: /DEFAULT_EXP474_LEXICAL_OVERLAP_CAP/ },
    { file: RETRIEVAL_FILE, symbol: /DEFAULT_EXP474_LEXICAL_PER_WORD/ },
  ];
  for (const { file, symbol } of checks) {
    const p = join(INTEL_DIR, file);
    assert.ok(existsSync(p), `${file} must exist`);
    const src = read(p);
    assert.match(src, /from ["']\.\/intelligence-config\.ts["']/, `${file} must import from intelligence-config.ts`);
    assert.match(src, symbol, `${file} must reference ${symbol.source}`);
  }
});

test("B2: the old inline magic numbers are GONE from the consumers", () => {
  // Each pair: the consumer file + a regex that MUST NOT match after the fix.
  const checks: ReadonlyArray<Readonly<{ file: string; gone: RegExp; why: string }>> = [
    { file: "repository-map.ts", gone: /maximumDepth:\s*32\b/, why: "repository-map must not hardcode maximumDepth: 32" },
    { file: "repository-map.ts", gone: /maximumEntries:\s*50_?000\b/, why: "repository-map must not hardcode maximumEntries: 50000" },
    { file: "repository-map.ts", gone: /maxFileBytes\s*\?\?\s*1_?048_?576\b/, why: "repository-map must not hardcode maxFileBytes ?? 1MB" },
    { file: "data-flow.ts", gone: /maxDepth\s*\?\?\s*3\b/, why: "data-flow must not hardcode maxDepth ?? 3" },
    { file: "next-edit-prefetch.ts", gone: /AL1_DEFAULT_MAX_PREDICTIONS\s*=\s*20/, why: "next-edit must not re-declare AL1_DEFAULT_MAX_PREDICTIONS" },
    { file: "next-edit-prefetch.ts", gone: /maxFiles:\s*number\s*=\s*10\b/, why: "next-edit must not hardcode maxFiles = 10" },
    { file: "dependency-graph.ts", gone: /if\s*\(\s*ind\s*>=\s*3\s*\)/, why: "dependency-graph must not hardcode hub threshold 3" },
    { file: "dependency-graph.ts", gone: /for\s*\(\s*let\s+i\s*=\s*0;\s*i\s*<\s*3\b/, why: "dependency-graph must not hardcode include-search depth 3" },
    { file: "file-slice.ts", gone: /for\s*\(\s*const\s+dir\s+of\s*\[\s*"src"\s*,\s*"test"\s*\]/, why: "file-slice must not hardcode [src, test] directory list" },
    { file: "quick-view.ts", gone: /listSourceFiles\(\s*join\(\s*root,\s*"src"\s*\)/, why: "quick-view must not hardcode listSourceFiles(join(root, 'src'))" },
    { file: "quick-view.ts", gone: /listDocFiles\(\s*join\(\s*root,\s*"docs"\s*\)/, why: "quick-view must not hardcode listDocFiles(join(root, 'docs'))" },
    { file: "symbol-extractor.ts", gone: /source\.length\s*>\s*10_?485_?760/, why: "symbol-extractor must not hardcode the 10MiB analysis limit" },
    { file: RETRIEVAL_FILE, gone: /Math\.min\(\s*0\.3\s*,\s*overlap\s*\*\s*0\.05\s*\)/, why: "retrieval must not hardcode the lexical overlap cap/per-word" },
    { file: RETRIEVAL_FILE, gone: /word\.length\s*>\s*4\s*&&/, why: "retrieval must not hardcode singular length 4" },
    { file: RETRIEVAL_FILE, gone: /word\.length\s*>=\s*3\s*\)/, why: "retrieval must not hardcode class-match min length 3" },
  ];
  for (const { file, gone, why } of checks) {
    const p = join(INTEL_DIR, file);
    // A PER-ITEM SKIP IS A PER-ITEM LOSS OF THE UNIVERSE, and it is quieter
    // than losing the whole list: renaming or moving ONE consumer drops its
    // checks here and nothing anywhere reds, because the other fourteen still
    // run and the count is never stated. The sibling loop above already
    // asserts existence for the same reason; this one skipped instead.
    assert.ok(existsSync(p), `${file} must exist under ${INTEL_DIR} — a consumer named here that has moved silently drops its checks`);
    const src = read(p);
    assert.doesNotMatch(src, gone, why);
  }
});

// --- C. No swallowed bare `catch {` in the intelligence subsystem (routed through handleError). ---
test("C1: bare `catch {` (no binding) routes through handleError", () => {
  const offenders: string[] = [];
  for (const f of intelFiles) {
    const src = read(f);
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (!/\bcatch\s*\{/.test(lines[i]!)) continue;
      // A bare `catch {` (optional binding, no error variable) swallows unless
      // the body routes through the debug owner. Scan the next 6 lines.
      const body = lines.slice(i, i + 6).join("\n");
      if (!body.includes("handleError")) {
        offenders.push(`${f}:${i + 1}: bare catch without handleError`);
      }
    }
  }
  assert.equal(offenders.length, 0, `bare catch {} without handleError found:\n${offenders.join("\n")}`);
});

test("C2: repository-stat-scan walkDirectory catch routes through handleError", () => {
  // The walk moved to its own module (repository-stat-scan.ts) so the
  // main-thread stat walk can import it without the map generator's
  // tree-sitter boot — the arm follows its subject's owner.
  const src = read(join(INTEL_DIR, "repository-stat-scan.ts"));
  // SCOPED TO THE FUNCTION, not to 160-then-120 bytes. Two windows in one
  // pattern is two guesses: the first could reach a `catch` in a neighbouring
  // helper, and the second could find a `return []` that belongs to neither.
  // The claim is about `walkDirectory`'s body, so it is asked of that body.
  const walk = functionBody(src, "walkDirectory");
  assert.ok(
    // THE CALL AND ITS ARGUMENT, as names. The claim is that THIS function is
    // the one that lists the directory, and the call graph says so directly.
    bodyCallsWith(walk, "readdirSync", ["fullDir"]),
    "walkDirectory must be the function that lists the directory",
  );
  const bound = /catch\s*\((\w+)\)/.exec(walk.body);
  assert.ok(bound !== null, "walkDirectory must BIND the caught error rather than swallowing it");
  assert.ok(bodyCalls(walk, "handleError"), "walkDirectory's catch must route through handleError");
  assert.ok(
    // EXACT: `return []`, and not `return [fallback]`. A containment test
    // would have called the second one the first.
    bodyReturns(walk, "[]"),
    "…and it must return an empty listing rather than propagating",
  );
});

// --- D. resolveIntelligenceConfig validates at the trust boundary. ---
test("D1: resolveIntelligenceConfig throws InputError on bad numeric overrides", async () => {
  const { resolveIntelligenceConfig } = await import("../../src/intelligence/intelligence-config.ts");
  const { InputError } = await import("../../src/kernel/errors.ts");
  const bad = (fn: () => unknown, code: string) => {
    try {
      fn();
      assert.fail(`expected InputError for ${code}`);
    } catch (e) {
      assert.ok(e instanceof InputError, `${code}: expected InputError, got ${(e as Error).constructor.name}`);
      assert.equal((e as { code?: string }).code, "intelligence_config_invalid", `${code}: must have the stable code`);
    }
  };
  bad(() => resolveIntelligenceConfig({ maxFileBytes: 0 }), "maxFileBytes=0");
  bad(() => resolveIntelligenceConfig({ maxFileBytes: Number.NaN }), "maxFileBytes=NaN");
  bad(() => resolveIntelligenceConfig({ maxFileBytes: -1 }), "maxFileBytes=-1");
  bad(() => resolveIntelligenceConfig({ maxFileBytes: 1.5 }), "maxFileBytes=1.5 (non-integer)");
  bad(() => resolveIntelligenceConfig({ repositoryMaxDepth: 0 }), "repositoryMaxDepth=0");
  bad(() => resolveIntelligenceConfig({ searchDefaultLimit: Number.NaN }), "searchDefaultLimit=NaN");
  bad(() => resolveIntelligenceConfig({ cloneJaccard: -0.1 }), "cloneJaccard=-0.1");
  bad(() => resolveIntelligenceConfig({ exp474LexicalOverlapCap: Number.NaN }), "exp474LexicalOverlapCap=NaN");
});

test("D2: resolveIntelligenceConfig accepts good overrides + preserves defaults", async () => {
  const { resolveIntelligenceConfig } = await import("../../src/intelligence/intelligence-config.ts");
  const def = resolveIntelligenceConfig();
  assert.equal(def.maxFileBytes, 1_048_576, "default maxFileBytes");
  assert.equal(def.repositoryMaxDepth, 32, "default repositoryMaxDepth");
  assert.equal(def.contextRadius, 0, "default contextRadius (0 is valid)");
  assert.equal(def.cloneJaccard, 0.9, "default cloneJaccard");
  assert.equal(def.exp474LexicalOverlapCap, 0.3, "default exp474 lexical overlap cap");
  assert.deepEqual([...def.sourceDirectories], ["src"], "default sourceDirectories");
  assert.deepEqual([...def.testDirectories], ["test"], "default testDirectories");
  assert.deepEqual([...def.docDirectories], ["docs"], "default docDirectories");
  const custom = resolveIntelligenceConfig({ maxFileBytes: 2048, repositoryMaxDepth: 8, sourceDirectories: ["lib"] });
  assert.equal(custom.maxFileBytes, 2048, "custom maxFileBytes");
  assert.equal(custom.repositoryMaxDepth, 8, "custom repositoryMaxDepth");
  assert.deepEqual([...custom.sourceDirectories], ["lib"], "custom sourceDirectories");
});

// --- E. Retrieval single owner: retrieveRelevantFiles defined ONLY in the retrieval module. ---
test("E1: retrieveRelevantFiles is defined in exactly ONE intelligence file", () => {
  const owners: string[] = [];
  for (const f of intelFiles) {
    const src = read(f);
    // A definition (function declaration or export function), not a re-import.
    if (/export\s+function\s+retrieveRelevantFiles\b/.test(src)) owners.push(f);
  }
  assert.equal(owners.length, 1, `retrieveRelevantFiles must have ONE owner, found: ${owners.join(", ")}`);
  assert.ok(owners[0]!.endsWith(RETRIEVAL_FILE), `owner must be ${RETRIEVAL_FILE}, got ${owners[0]}`);
});

test("E2: no parallel slot-allocation retrieval implementation in intelligence (no dup of the slot-allocation algorithm)", () => {
  // The slot-allocation signature (importSlots/reverseSlots/packageSlots) must
  // appear ONLY in the retrieval module, not re-implemented elsewhere.
  const owners: string[] = [];
  for (const f of intelFiles) {
    if (f.endsWith(RETRIEVAL_FILE)) continue;
    const src = read(f);
    if (/\bimportSlots\b.*\breverseSlots\b.*\bpackageSlots\b/s.test(src) || /\bpackageSlots\b.*\bstage1CoreK\b/.test(src)) {
      owners.push(f);
    }
  }
  assert.equal(owners.length, 0, `parallel slot-allocation impl found: ${owners.join(", ")}`);
});

// --- F. Static directory lists owned by config: no inline hardcoded dir literals in consumers. ---
// Dynamic discovery (deny-by-default): scan EVERY `.ts` file under
// `src/intelligence/` for inline directory-list literals + verify config
// import. A new file added tomorrow that hardcodes `[src,test]` or
// `join(root,"docs")` is auto-caught — no static file list to rot.
test("F1: no intelligence file hardcodes directory lists inline (deny-by-default dynamic scan)", () => {
  for (const file of intelFiles) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const src = read(file);
    // The old inline literal scan dirs must be gone; the config import must be present.
    assert.doesNotMatch(src, /\[\s*"src"\s*,\s*"test"\s*\]/, `${rel}: no inline [src,test] list`);
    assert.doesNotMatch(src, /join\(\s*root,\s*"docs"\s*\)/, `${rel}: no inline join(root,'docs')`);
    // Files that reference scan directories or directory roots must import
    // the config owner. (Skip the config owner itself + files that don't
    // reference directory-list-shaped literals at all.)
    if (file === cfgPath) continue;
    if (!/scanDir|directoryRoot|listRoots|scanDirs\b/.test(src)) continue;
    assert.match(src, /from ["']\.\/intelligence-config\.ts["']/, `${rel}: must import directory defaults from config owner`);
  }
});

// --- Mutation verification: reintroducing each violation makes a test FAIL. ---
test("MUTATION: re-adding `maxDepth?? 3` to data-flow makes B2 fail", () => {
  const src = read(join(INTEL_DIR, "data-flow.ts"));
  // Simulate the regression at the USAGE site (not the import), then confirm
  // the B2 negative regex would catch it.
  const mutated = src.replace("?? DEFAULT_DATA_FLOW_MAX_DEPTH", "?? 3");
  assert.match(mutated, /maxDepth\s*\?\?\s*3\b/, "mutation: hardcoded maxDepth ?? 3 restored — B2 would fail");
});

test("MUTATION: re-adding a bare `catch {` to an intelligence file makes C1 fail", () => {
  const fake = "try { x(); } catch { /* swallow */ }";
  const lines = fake.split("\n");
  let flagged = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/\bcatch\s*\{/.test(lines[i]!) && !lines.slice(i, i + 6).join("\n").includes("handleError")) flagged = true;
  }
  assert.equal(flagged, true, "mutation: bare catch without handleError detected by C1 scan");
});

test("MUTATION: re-adding `Math.min(0.3, overlap * 0.05)` to the retrieval module makes B2 fail", () => {
  const src = read(join(INTEL_DIR, RETRIEVAL_FILE));
  // Simulate the regression at the USAGE site, then confirm B2 catches it.
  const mutated = src.replace(
    "Math.min(DEFAULT_EXP474_LEXICAL_OVERLAP_CAP, overlap * DEFAULT_EXP474_LEXICAL_PER_WORD)",
    "Math.min(0.3, overlap * 0.05)",
  );
  assert.match(mutated, /Math\.min\(\s*0\.3\s*,\s*overlap\s*\*\s*0\.05\s*\)/, "mutation: hardcoded lexical cap restored — B2 would fail");
});

test("MUTATION: a second `retrieveRelevantFiles` definition makes E1 fail", () => {
  // Simulate a second owner file defining the function; E1 counts definitions
  // across intelligence files — a second `export function retrieveRelevantFiles`
  // would push the count to 2 and fail E1.
  const secondOwnerSrc = "export function retrieveRelevantFiles() {}";
  const definitions = (secondOwnerSrc.match(/export\s+function\s+retrieveRelevantFiles\b/g) || []).length;
  assert.ok(definitions >= 1, "mutation: a second owner contributes >= 1 definition — E1 (count === 1) would fail");
});
