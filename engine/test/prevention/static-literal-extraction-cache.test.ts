// Prevention test for the filesystem-backed static-literal extraction cache
// + the harness sync --with-bundle workflow improvement.
//
// The static-literal extraction cache stores the EVALUATED extraction result
// (a JSON-serializable { ok, value? }) instead of the non-serializable Babel
// AST, so it can be shared across the serial-phase processes. This test
// verifies the cache is wired (config field + cache instance + cache directory
// constant) using dynamic discovery — no hardcoded lists (deny-by-default).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES,
} from "../../src/workflow/workflow-config.ts";
import { canonicalHash, canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";
import { createFilesystemCache } from "../../scripts/verification/filesystem-cache.ts";
import { extractBoundedTopLevelStaticLiteral } from "../../scripts/tooling/s1-verification.ts";
import { createTempDir } from "../support/temp-dir.ts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(MODULE_DIR, "..", "..");
const S1_VERIFICATION_PATH = join(REPO_ROOT, "scripts", "tooling", "s1-verification.ts");

test("static-literal extraction cache: config field is a positive finite number", () => {
  assert.equal(
    typeof DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES,
    "number",
  );
  assert.ok(
    Number.isFinite(DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES) &&
      DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES > 0,
    "cache max entries must be a positive finite number",
  );
});

test("static-literal extraction cache: s1-verification wires the filesystem cache + the extraction wrapper", () => {
  // Dynamic source scan (no hardcoded list): verify the cache is actually
  // wired into s1-verification.ts. If someone removes the cache, this fails.
  const source = readFileSync(S1_VERIFICATION_PATH, "utf8");
  assert.ok(
    source.includes("staticLiteralExtractionFilesystemCache"),
    "s1-verification.ts must create the static-literal extraction filesystem cache",
  );
  assert.ok(
    source.includes("createFilesystemCache"),
    "s1-verification.ts must use the shared createFilesystemCache owner",
  );
  assert.ok(
    source.includes("validateStaticLiteralExtraction"),
    "s1-verification.ts must validate cached extractions (deny-by-default — a corrupt cache file must not produce wrong results)",
  );
  // The extraction wrapper must delegate to a compute inner function so the
  // cache check + write happen at a single choke point (no scattered cache logic).
  assert.ok(
    source.includes("computeBoundedTopLevelStaticLiteral"),
    "s1-verification.ts must separate the cache wrapper from the compute (choke-point caching)",
  );
  // The cache key must incorporate every input that affects the output
  // (content hash + bindingName + propertyPath + freezeBoundary + identifierBindings).
  assert.ok(
    source.includes("boundaryHash") && source.includes("bindingsHash"),
    "s1-verification.ts cache key must hash the freezeBoundary + identifierBindings (correctness — distinct tuples must not collide)",
  );
});

test("static-literal extraction cache: ignores entries keyed before the evaluator's current bytes", () => {
  // A cached extraction is a function of the analyzed source, the tuple
  // (bindingName, propertyPath, freezeBoundary, identifierBindings) AND the
  // evaluator that produced it. An entry written under the pre-salt key —
  // the format the cache used before the evaluator's own bytes joined the
  // key — must never be served: plant a fabricated extraction under exactly
  // that key and require the extraction to compute fresh. The planted key is
  // unreachable by any product path after the salt, exactly the tripwire
  // that reds if anyone severs it. The probe's value carries a schemaId
  // call, so the fresh pass resolves the behavioral dependency
  // (product-identity.ts) inside the cached derivation — the exact leg of
  // the value the salt exists to protect.
  const probeSource = [
    'import { schemaId } from "./product-identity.ts";',
    "export const STATIC_LITERAL_CACHE_PROBE_BINDING = {",
    '  marker: "freshAnalyzerResult",',
    '  schema: schemaId("static-literal-probe", 1),',
    "};",
  ].join("\n");
  const contentHash = sha256(Buffer.from(probeSource, "utf8"));
  const preSaltKey = `${contentHash}\u0000STATIC_LITERAL_CACHE_PROBE_BINDING\u0000\u0000none\u0000${canonicalHash({})}`;
  const cache = createFilesystemCache({
    directory: "harness-static-literal-cache",
    maxEntries: DEFAULT_STATIC_LITERAL_EXTRACTION_FILESYSTEM_CACHE_MAX_ENTRIES,
  });
  cache.write(preSaltKey, { ok: true, value: "staleAnalyzerResult" });
  // Liveness: the planted entry is servable under its own pre-salt key — the
  // tripwire is armed, and serving it on the product path is exactly what
  // severing the salt would do.
  const validateExtraction = (value: unknown): unknown =>
    typeof value === "object" && value !== null ? value : undefined;
  assert.deepEqual(
    cache.read(preSaltKey, validateExtraction),
    { ok: true, value: "staleAnalyzerResult" },
    "liveness: the planted pre-salt entry must be readable under its own key (an unreachable plant would make this arm vacuous)",
  );
  const extraction = extractBoundedTopLevelStaticLiteral(
    probeSource,
    "STATIC_LITERAL_CACHE_PROBE_BINDING",
    [],
  );
  assert.equal(extraction.ok, true, "the fresh extraction must run: the probe binding is a static literal");
  if (!extraction.ok) return;
  // The evaluator materializes objects with a null prototype while a cached
  // round-trip carries Object.prototype, so the comparison goes through the
  // canonical serialization — the same primitive the cached value's own
  // byte gate uses — keeping the arm deterministic warm and cold.
  assert.equal(
    canonicalJson(extraction.value),
    canonicalJson({ marker: "freshAnalyzerResult", schema: schemaId("static-literal-probe", 1) }),
    "a cache entry keyed without the evaluator's bytes must not be served for the current evaluator bytes",
  );
  assert.notEqual(extraction.value, "staleAnalyzerResult",
    "the planted pre-salt marker must never be served");
});

// ── The cache-directory uniqueness guard ──────────────────────────────────
//
// LADDER VERDICT: rung 5, and the reason it stops there is specific.
//   Rung 1 unavailable — a cache directory name is a source-level string; no
//     OS object exists at declaration time that could refuse a second one.
//   Rung 2 (unrepresentable) IS structurally available and is NOT taken here:
//     keying a registry BY the directory name (`{ "harness-s1-cache": reason }
//     as const`) makes a duplicate a TS1117 "object literal cannot have
//     multiple properties with the same name" at the single declaration, and
//     typing `FilesystemCacheConfig.directory` as `keyof typeof REGISTRY`
//     makes an unregistered directory a compile error (rung 3). It is blocked
//     TODAY by exactly one consumer: `test/prevention/filesystem-cache-shared-
//     counter.test.ts:36` builds its directory at RUN TIME
//     (`harness-test-fs-cache-${randomBytes(8)}`), which no `keyof` can name.
//     Recorded as its own task rather than half-done here.
//   Rung 4 unavailable — `createFilesystemCache` sees only the directory
//     string, and two instances over ONE directory are LEGITIMATE and load-
//     bearing (the shared-counter test constructs 20 of them deliberately to
//     simulate 20 processes). The door cannot tell a re-creation of the same
//     logical cache from a second, distinct cache, so it cannot refuse.
//
// WHAT THIS GUARD USED TO BE, and why it could never fail: it collected the
// names into a `Set<string>`, spread that Set into `allNames`, and asserted
// `new Set(allNames).size === allNames.length`. A Set spread into an array is
// unique by construction, so both operands were derived from each other
// through the very operation that guarantees the asserted property. DRIVEN:
// planting a second call site with an already-taken directory left the
// discovered count unchanged (the Set absorbed the collision) and the
// assertion still passed. The uniqueness claim is now made over the list
// BEFORE deduplication, and each occurrence carries the site that produced it
// so the failure message names both halves of a collision.

type DirectorySource = Readonly<{
  /** Which discovery pattern produced this source — the liveness unit. */
  pattern: string;
  /** Human-readable origin, printed in the collision message. */
  label: string;
  path: string;
  matcher: RegExp;
}>;

type DirectoryOccurrence = Readonly<{ pattern: string; label: string; name: string }>;

/**
 * The declared cache-directory naming patterns. Deny by default: every pattern
 * must discover at least one occurrence, because a pattern that matches
 * nothing shrinks the universe SILENTLY (§31 — a partial loss of a universe is
 * invisible; only a total one is caught).
 *
 * This is not hypothetical here. The constant pattern was written
 * `/DEFAULT_[A-Z_]*FILESYSTEM_CACHE_DIRECTORY\s*=\s*"([^"]+)"/` — and
 * `[A-Z_]` excludes DIGITS, so it could not match the only constant in
 * `workflow-config.ts`, `DEFAULT_S1_FILESYSTEM_CACHE_DIRECTORY =
 * "harness-s1-cache"`. One of three sources discovered zero for as long as it
 * has existed, and nothing said so.
 */
const CONSTANT_DECLARATION_PATTERN = /DEFAULT_[A-Z0-9_]*FILESYSTEM_CACHE_DIRECTORY\s*=\s*"([^"]+)"/gu;
const INLINE_DIRECTORY_PATTERN = /directory:\s*"([^"]+)"/gu;

function realDirectorySources(): DirectorySource[] {
  const sources: DirectorySource[] = [
    {
      pattern: "workflow-config constant",
      label: "src/workflow/workflow-config.ts",
      path: join(REPO_ROOT, "src", "workflow", "workflow-config.ts"),
      matcher: CONSTANT_DECLARATION_PATTERN,
    },
  ];
  // The cache directory names are also inlined in createFilesystemCache calls;
  // discover those too from the verification sources.
  const verificationDir = join(REPO_ROOT, "scripts", "verification");
  for (const name of readdirSync(verificationDir).filter((f) => f.endsWith(".ts"))) {
    sources.push({
      pattern: "verification inline directory",
      label: `scripts/verification/${name}`,
      path: join(verificationDir, name),
      matcher: INLINE_DIRECTORY_PATTERN,
    });
  }
  // s1-verification.ts inlines its cache directory too.
  sources.push({
    pattern: "s1-verification inline directory",
    label: "scripts/tooling/s1-verification.ts",
    path: S1_VERIFICATION_PATH,
    matcher: INLINE_DIRECTORY_PATTERN,
  });
  return sources;
}

/**
 * Every occurrence, in discovery order, WITHOUT deduplication. The list is the
 * subject of the uniqueness claim; a Set would answer the question by erasing
 * the evidence.
 */
function discoverDirectoryOccurrences(sources: readonly DirectorySource[]): DirectoryOccurrence[] {
  const occurrences: DirectoryOccurrence[] = [];
  for (const source of sources) {
    const fileSource = readFileSync(source.path, "utf8");
    // A `g`-flagged literal carries `lastIndex` between uses; reset per file.
    source.matcher.lastIndex = 0;
    for (const match of fileSource.matchAll(source.matcher)) {
      occurrences.push({ pattern: source.pattern, label: source.label, name: match[1]! });
    }
  }
  return occurrences;
}

/** The collisions: every directory name claimed by more than one site. */
function collidingDirectories(
  occurrences: readonly DirectoryOccurrence[],
): { name: string; sites: string[] }[] {
  const byName = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const sites = byName.get(occurrence.name) ?? [];
    sites.push(occurrence.label);
    byName.set(occurrence.name, sites);
  }
  return [...byName]
    .filter(([, sites]) => sites.length > 1)
    .map(([name, sites]) => ({ name, sites }));
}

test("static-literal extraction cache: every cache-directory discovery pattern is live", () => {
  const sources = realDirectorySources();
  const occurrences = discoverDirectoryOccurrences(sources);
  // §29b/§8b: print what was extracted, once, backed by an assertion — a
  // display diagnoses, only an assertion gates.
  console.log(
    `[cache-directory discovery] ${occurrences.length} occurrences, ${new Set(occurrences.map((o) => o.name)).size} distinct names`,
  );
  for (const occurrence of occurrences) {
    console.log(`  ${occurrence.pattern} :: ${occurrence.label} -> ${occurrence.name}`);
  }
  const declaredPatterns = [...new Set(sources.map((source) => source.pattern))];
  assert.ok(declaredPatterns.length > 0, "the cache-directory source list must not be empty");
  for (const pattern of declaredPatterns) {
    const hits = occurrences.filter((occurrence) => occurrence.pattern === pattern);
    assert.ok(
      hits.length > 0,
      `cache-directory pattern "${pattern}" discovered NOTHING — it is dead, and a dead pattern shrinks the uniqueness universe silently. Either the pattern no longer matches how directories are declared, or the declarations moved.`,
    );
  }
});

test("static-literal extraction cache: cache directory name is unique among harness caches", () => {
  const occurrences = discoverDirectoryOccurrences(realDirectorySources());
  assert.ok(
    occurrences.some((occurrence) => occurrence.name === "harness-static-literal-cache"),
    "the static-literal extraction cache directory must be registered",
  );
  // Uniqueness: no two cache instances may share a directory (a collision
  // would mix cache entries + corrupt the cache key namespaces). Asserted over
  // the PRE-DEDUPLICATION list — see the note above.
  const collisions = collidingDirectories(occurrences);
  assert.deepEqual(
    collisions,
    [],
    `cache directory names must be unique; collisions: ${collisions
      .map((collision) => `"${collision.name}" claimed by ${collision.sites.join(" + ")}`)
      .join("; ")}`,
  );
});

test("static-literal extraction cache: the uniqueness guard REFUSES a planted duplicate", () => {
  // §28a — the plant is a temp file injected into the source list, never a
  // live tracked file. The old guard certified this exact input as unique.
  const plantDir = createTempDir("harness-cache-directory-plant-");
  const plantPath = join(plantDir, "planted-cache.ts");
  const taken = discoverDirectoryOccurrences(realDirectorySources())[0]!.name;
  writeFileSync(
    plantPath,
    `const planted = createFilesystemCache({ directory: "${taken}", maxEntries: 1 });\n`,
    "utf8",
  );
  const withPlant = [
    ...realDirectorySources(),
    {
      pattern: "planted duplicate",
      label: "<<planted>>",
      path: plantPath,
      matcher: INLINE_DIRECTORY_PATTERN,
    },
  ];
  const collisions = collidingDirectories(discoverDirectoryOccurrences(withPlant));
  assert.equal(collisions.length, 1, "the planted duplicate must be reported as exactly one collision");
  assert.equal(collisions[0]!.name, taken);
  assert.ok(
    collisions[0]!.sites.includes("<<planted>>"),
    "the collision must name the planted site, not merely report that one exists",
  );

  // The INERT direction: the same plant with a directory nobody has claimed
  // must produce NO collision. Without this, a `collidingDirectories` that
  // returned every name would pass the assertion above.
  writeFileSync(
    plantPath,
    `const planted = createFilesystemCache({ directory: "harness-not-claimed-by-anyone", maxEntries: 1 });\n`,
    "utf8",
  );
  assert.deepEqual(
    collidingDirectories(discoverDirectoryOccurrences(withPlant)),
    [],
    "a planted directory nobody else claims must NOT be reported as a collision",
  );
});

test("static-literal cache preserves ordered property segments in both warm orders", () => {
  for (const reverse of [false, true]) {
    const source = `const root = { "a.b": 1, a: { b: 2 }, "": 3 }; // tuple-${reverse}`;
    const cases = [{ path: ["a.b"], value: 1 }, { path: ["a", "b"], value: 2 }, { path: [""], value: 3 }];
    if (reverse) cases.reverse();
    for (const entry of [...cases, ...cases]) {
      assert.deepEqual(extractBoundedTopLevelStaticLiteral(source, "root", entry.path), { ok: true, value: entry.value });
    }
    assert.deepEqual(extractBoundedTopLevelStaticLiteral(source, "missing", ["a.b"]), { ok: false });
    assert.deepEqual(extractBoundedTopLevelStaticLiteral(source.replace('"a.b": 1', '"a.b": 4'), "root", ["a.b"]), { ok: true, value: 4 });
    const expectedRoot = { ok: true, value: { "a.b": 1, a: { b: 2 }, "": 3 } };
    for (let repeat = 0; repeat < 2; repeat += 1) {
      assert.equal(canonicalJson(extractBoundedTopLevelStaticLiteral(source, "root", [])), canonicalJson(expectedRoot));
      assert.deepEqual(extractBoundedTopLevelStaticLiteral(source, "root", [""]), { ok: true, value: 3 });
    }
  }
});

test("static-literal cache hashes current nested identifier binding values and import source", () => {
  const source = 'import { Values } from "./values.ts"; const ROOT = { selected: Values.marker };';
  const bindings = { Values: { importSource: "./values.ts", value: { marker: 1 } } };
  const read = () => extractBoundedTopLevelStaticLiteral(source, "ROOT", ["selected"], undefined, bindings);
  assert.deepEqual(read(), { ok: true, value: 1 });
  Object.freeze(bindings);
  bindings.Values.value.marker = 2;
  assert.deepEqual(read(), { ok: true, value: 2 }, "shallow freeze is not proof of immutable nested values");
  assert.deepEqual(read(), { ok: true, value: 2 });
  assert.deepEqual(extractBoundedTopLevelStaticLiteral(source + " // cold", "ROOT", ["selected"], undefined, bindings), { ok: true, value: 2 });
  bindings.Values.importSource = "./wrong.ts";
  assert.deepEqual(read(), { ok: false });
  bindings.Values.importSource = "./values.ts";
  assert.deepEqual(read(), { ok: true, value: 2 });
});

test("static-literal cache hashes each current freeze boundary field", () => {
  const source = 'import { deepFreeze } from "./freeze.ts"; const VALUE = { selected: 1 }; export type Value = typeof VALUE; export const ROOT = deepFreeze(VALUE);';
  const boundary = { exportedName: "ROOT", freezerImportSource: "./freeze.ts", freezerName: "deepFreeze", typeName: "Value" };
  const read = () => extractBoundedTopLevelStaticLiteral(source, "VALUE", ["selected"], boundary);
  assert.deepEqual(read(), { ok: true, value: 1 });
  for (const field of Object.keys(boundary) as (keyof typeof boundary)[]) {
    const original = boundary[field];
    boundary[field] = "wrong";
    assert.deepEqual(read(), { ok: false }, field);
    boundary[field] = original;
    assert.deepEqual(read(), { ok: true, value: 1 });
  }
});
