import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * INVARIANT #57: Math.random must not be used for ID generation in src/
 * (non-test) files. Cryptographically-weak IDs (randomUUID, generateId,
 * etc.) are the canonical owners. Math.random is permitted only for:
 * - retry jitter
 * - sampling
 * - temp file suffixes
 * - extension default ID generators that accept an injectable override
 *
 * The set of critical ID-generation files is derived DYNAMICALLY: every
 * src/ file that imports the canonical `generateId` or `generateShortId`
 * (from an `integrity.ts` path) OR imports `randomUUID` from `node:crypto`
 * is an ID-generation module that must not use Math.random for ID
 * generation. A new ID-generation file added anywhere in src/ is
 * automatically covered (deny-by-default); no hand-maintained list that
 * would silently miss it.
 *
 * This file also enforces the single canonical owner for ALL
 * cryptographically-secure uniqueness used as identifiers, for ALL
 * SHA-256 hashing, and for ALL random-byte generation: `src/integrity.ts`
 * is the ONE module that imports `randomUUID`, `createHash`, and
 * `randomBytes` from `node:crypto`. Every other src/ file that needs an
 * identifier goes through `generateId`/`generateShortId` (prefixed) or
 * `randomUuid` (raw, non-identifier uniqueness), every file that needs a
 * digest goes through `sha256`/`sha256Bytes`, and every file that needs
 * random bytes goes through `randomBytes(byteLength)`. A new file importing
 * `randomUUID`, `createHash`, or `randomBytes` from `node:crypto` directly
 * is caught automatically (deny-by-default) — there is no allowlist to rot.
 */

const SRC_ROOT = join(process.cwd(), "src");
// The canonical owner's src/-relative path, resolved from the tree — the fold
// moved it under kernel/, so the path is never spelled here.
const INTEGRITY_OWNER = engineModuleSourceRelative("integrity.ts");
// The web server tree, sibling to engine/ in the repository. The canonical-id
// ownership rule spans BOTH trees: the server reaches the same owner through
// its canonical hub (`server/kernel/canonical.ts` re-exports generateId /
// randomUuid), so a direct node:crypto import there is the same bypass.
const SERVER_ROOT = join(process.cwd(), "..", "server");

function listTsFilesBothRoots(): string[] {
  return [...listTsFiles(SRC_ROOT), ...listTsFiles(SERVER_ROOT)];
}

function listTsFiles(dir: string): string[] {
  return walk(dir, { exts: [".ts"] });
}

interface RandomUsage {
  file: string;
  line: number;
  text: string;
}

function findMathRandomUsages(): RandomUsage[] {
  const usages: RandomUsage[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Only flag actual CALLS (`Math.random(`), not mentions inside string
      // literals, regex definitions, or doc comments. A message string like
      // "...ECB/Math.random)" or a regex `Math\.random\s*\(` contains the
      // token but is not a call; requiring the opening paren distinguishes
      // them. Comment lines are skipped too.
      if (!/\bMath\.random\s*\(/.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      usages.push({ file: relative(process.cwd(), file), line: i + 1, text: line.trim() });
    }
  }
  return usages;
}

type Category = "jitter" | "sampling" | "temp-suffix" | "extension-id" | "simulation" | "unknown";

function classifyUsage(usage: RandomUsage): Category {
  const text = usage.text.toLowerCase();
  if (text.includes("jitter") || text.includes("backoff")) return "jitter";
  if (text.includes("sampling") || text.includes("samplingrate") || /<\s*samplingrate/.test(text)) return "sampling";
  if (usage.file.includes("atomic-write") || text.includes("temp") || text.includes("suffix")) return "temp-suffix";
  if (usage.file.includes("approval-workflow")) return "extension-id";
  if (/id|uuid|identifier/i.test(usage.text)) return "extension-id";
  // Synthetic tool/metric simulations in the exposure registration fixtures
  // (e.g. a simulated retrieval with a random hit-rate and latency) use
  // Math.random for demo metrics, not ID generation. These live under
  // `src/shared/exposure/registrations/` and are the canonical place for
  // synthetic registrations; they are not security-sensitive ID paths.
  if (usage.file.includes("exposure/registrations")) return "simulation";
  return "unknown";
}

/**
 * Discover the critical ID-generation files dynamically: every src/ `.ts`
 * file that imports the canonical `generateId` or `generateShortId` from an
 * `integrity.ts` path. These are the unambiguous consumers of the single
 * canonical ID generator (the SPO owner) — a new consumer added anywhere in
 * src/ is automatically covered (deny-by-default), with no hand-maintained
 * list that can rot.
 *
 * Note: a module that constructs IDs by calling `randomUUID` from
 * `node:crypto` DIRECTLY (bypassing the canonical `generateId` owner) is a
 * separate SPO concern — it bypasses the single ID-generator owner. Such a
 * module is caught by the "no direct randomUUID import outside the owner"
 * test below. Its `Math.random` usage is still caught by the "all usages in
 * allowed categories" test below.
 */
function findIdGeneratingFiles(): string[] {
  const out: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    // Imports `generateId` or `generateShortId` from a path ending in
    // `integrity.ts` (the canonical ID-generator owner). The import must
    // bind the name by name (an `as` alias still references the owner path).
    const importsGenerateId = /import\s*\{[^}]*\b(?:generateId|generateShortId)\b[^}]*\}\s*from\s*["'][^"']*integrity\.ts["']/.test(source);
    if (importsGenerateId) {
      out.push(relative(process.cwd(), file).replaceAll("\\", "/"));
    }
  }
  return out.sort();
}

const CRITICAL_ID_FILES = findIdGeneratingFiles();

test("MathRandom: critical ID files do not use Math.random for ID generation", () => {
  // Non-empty guard: a broken discovery must not make the contract vacuously
  // pass. The set must be non-empty (the canonical generateId owner has
  // consumers).
  assert.ok(CRITICAL_ID_FILES.length > 0, "the dynamically discovered generateId-importer set must be non-empty");
  for (const relPath of CRITICAL_ID_FILES) {
    const absPath = join(process.cwd(), relPath);
    let source: string;
    try {
      source = readFileSync(absPath, "utf8");
    } catch {
      assert.fail(`critical ID file not found: ${relPath}`);
    }
    const lines = source.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!/\bMath\.random\s*\(/.test(line)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      const usage: RandomUsage = { file: relPath, line: i + 1, text: line.trim() };
      const category = classifyUsage(usage);
      // An ID-generation module may still use Math.random for legitimate
      // non-identifier purposes (sampling, retry jitter, temp suffixes).
      // Only the uncategorized ("unknown") and the ID-via-Math.random
      // ("extension-id") classes are forbidden here; the second test below
      // enforces the same deny-by-default across all src/ files.
      assert.notEqual(
        category,
        "unknown",
        `${relPath}:${i + 1} uses Math.random in an unclassified context (ID-generation module): ${line.trim()}`,
      );
      assert.notEqual(
        category,
        "extension-id",
        `${relPath}:${i + 1} uses Math.random for ID generation: ${line.trim()}`,
      );
    }
  }
});

test("MathRandom: all Math.random usages in src/ fall into allowed categories", () => {
  const usages = findMathRandomUsages();
  const disallowed = usages.filter((u) => classifyUsage(u) === "unknown");
  assert.equal(
    disallowed.length,
    0,
    `Math.random used in unclassified contexts:\n${disallowed.map((u) => `${u.file}:${u.line} → ${u.text}`).join("\n")}`,
  );
});

test("MathRandom: any extension using Math.random for IDs must have an injectable idGenerator override", () => {
  const usages = findMathRandomUsages();
  const idGenFiles = usages.filter((u) => classifyUsage(u) === "extension-id");
  for (const usage of idGenFiles) {
    const source = readFileSync(join(process.cwd(), usage.file), "utf8");
    assert.ok(
      /idGenerator/.test(source),
      `${usage.file} uses Math.random for IDs and must accept an injectable idGenerator override`,
    );
  }
});

/**
 * Deny-by-default: `randomUUID` (the cryptographically-secure uniqueness
 * primitive) must be imported ONLY from the canonical owner module
 * `src/integrity.ts`. Every other file that needs an identifier goes
 * through `generateId`/`generateShortId` (prefixed) or `randomUuid` (raw,
 * non-identifier uniqueness), both exported by the owner — in the engine
 * directly, in the web server through its canonical hub. A new file
 * importing `randomUUID` from `node:crypto` directly bypasses the single
 * owner and is caught automatically — there is no hand-maintained allowlist
 * that could silently miss it.
 *
 * THE UNIVERSE IS BOTH TREES. This arm originally walked only the engine's
 * src/, which left the web server free to mint ids outside the owner —
 * measured: two prefixed ids (`resp-`, `ledger-`) and ten raw-uniqueness
 * sites all imported `randomUUID` directly while this arm stayed green. A
 * guard whose scan population omits a tree that shares the owner is a
 * false-absence lie, so the walk now covers `server/` too, and the
 * non-vacuous-count witness below covers BOTH roots.
 */
test("CanonicalIdOwner: randomUUID is imported only from the canonical owner (src/integrity.ts)", () => {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of listTsFilesBothRoots()) {
    const relPath = relative(process.cwd(), file).replaceAll("\\", "/");
    scanned += 1;
    if (relPath === INTEGRITY_OWNER) continue;
    const source = readFileSync(file, "utf8");
    // An `import { ... randomUUID ... } from "node:crypto"` line. The bind
    // name must be `randomUUID` (an `as` alias still bypasses the owner).
    if (/import\s*\{[^}]*\brandomUUID\b[^}]*\}\s*from\s*["']node:crypto["']/.test(source)) {
      offenders.push(relPath);
    }
  }
  assert.ok(
    scanned > 500,
    `witness: the scan actually walked both trees (${scanned} files) — a scan that ` +
      `walks nothing proves nothing`,
  );
  assert.equal(
    offenders.length,
    0,
    `randomUUID must be imported only from the canonical owner (the engine's ` +
      `src/integrity.ts; the web server reaches it through its canonical hub). ` +
      `Offending files import randomUUID from node:crypto directly, bypassing the owner:\n` +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
});

/**
 * Deny-by-default: `createHash` (the SHA-256 hashing primitive) must be
 * imported ONLY from a canonical digest owner. The engine's owner is
 * `src/integrity.ts` (every other engine file reaches it through
 * `sha256`/`sha256Bytes`); the web server tree has its own digest owner
 * module exporting the `sha256` wrapper, discovered here BY SHAPE and never
 * by a spelled path: the one server module that both imports the primitive
 * and exports `function sha256(` IS the owner, a second such module is a
 * second owner (and reds the count assertion below), and any other server
 * file importing `createHash` directly bypasses the owner and is caught
 * automatically — no hand-maintained allowlist that could rot.
 *
 * THE UNIVERSE IS BOTH TREES. This arm originally walked only the engine's
 * src/, which left the web server free to hash outside its owner — the
 * measured instance (the sweep arm-flags block minting its document digest
 * with a private three-call expression while the digest owner existed
 * beside it) stayed invisible to a green run. A guard whose scan population
 * omits a tree that shares the owner is a false-absence lie, so the walk
 * covers `server/` too, with the same non-vacuous witness the id arm
 * carries.
 */
test("CanonicalHashOwner: createHash is imported only from the canonical owners (engine src/integrity.ts; the server's digest owner)", () => {
  const offenders: string[] = [];
  const serverDigestOwners: string[] = [];
  let scanned = 0;
  for (const file of listTsFilesBothRoots()) {
    const relPath = relative(process.cwd(), file).replaceAll("\\", "/");
    scanned += 1;
    if (relPath === INTEGRITY_OWNER) continue;
    const source = readFileSync(file, "utf8");
    const importsCreateHash = /import\s*\{[^}]*\bcreateHash\b[^}]*\}\s*from\s*["']node:crypto["']/.test(source);
    // The server's digest owner, by shape: a server file that imports the
    // primitive AND exports the wrapper. A server file exporting the wrapper
    // without importing the primitive is a re-exporter, not the owner, and
    // never reaches this exemption.
    const isServerFile = !relative(SERVER_ROOT, file).startsWith("..");
    const exportsSha256Wrapper = /export\s+function\s+sha256\s*\(/.test(source);
    if (isServerFile && importsCreateHash && exportsSha256Wrapper) {
      serverDigestOwners.push(relPath);
      continue;
    }
    if (importsCreateHash) {
      offenders.push(relPath);
    }
  }
  assert.ok(
    scanned > 500,
    `witness: the scan actually walked both trees (${scanned} files) — a scan that ` +
      `walks nothing proves nothing`,
  );
  assert.equal(
    serverDigestOwners.length,
    1,
    `the server tree must hold exactly ONE digest owner module (the module that ` +
      `imports createHash and exports the sha256 wrapper); found: ` +
      serverDigestOwners.join(", "),
  );
  assert.equal(
    offenders.length,
    0,
    `createHash must be imported only from the canonical owners (the engine's ` +
      `src/integrity.ts; the server's digest owner module). Offending files import ` +
      `createHash from node:crypto directly, bypassing the owner:\n` +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
});

/**
 * Deny-by-default: `randomBytes` (the cryptographically-secure random-byte
 * primitive) must be imported ONLY from the canonical owner module
 * `src/integrity.ts`. Every other src/ file that needs a random byte sequence
 * goes through the owner's `randomBytes(byteLength)` wrapper, which validates
 * the length at the trust boundary. A new src/ file importing `randomBytes`
 * from `node:crypto` directly bypasses the single owner and is caught
 * automatically — there is no hand-maintained allowlist that could miss it.
 */
test("CanonicalRandomBytesOwner: randomBytes is imported only from the canonical owner (src/integrity.ts)", () => {
  const offenders: string[] = [];
  for (const file of listTsFiles(SRC_ROOT)) {
    const relPath = relative(process.cwd(), file).replaceAll("\\", "/");
    if (relPath === INTEGRITY_OWNER) continue;
    const source = readFileSync(file, "utf8");
    if (/import\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*["']node:crypto["']/.test(source)) {
      offenders.push(relPath);
    }
  }
  assert.equal(
    offenders.length,
    0,
    `randomBytes must be imported only from src/integrity.ts (the canonical owner). ` +
      `Offending files import randomBytes from node:crypto directly, bypassing the owner:\n` +
      offenders.map((f) => `  ${f}`).join("\n"),
  );
});

/**
 * Sanity guard: the canonical owner module `src/integrity.ts` must actually
 * exist and must export the canonical ID generators. If the owner were
 * renamed or removed, the deny-by-default tests above would vacuously pass
 * (no file matches the owner path), so this guard keeps the contract
 * non-vacuous.
 */
test("CanonicalIdOwner: the owner module src/integrity.ts exists and exports the canonical generators", () => {
  const ownerPath = join(process.cwd(), INTEGRITY_OWNER);
  let source: string;
  try {
    source = readFileSync(ownerPath, "utf8");
  } catch {
    assert.fail(`canonical owner module not found: ${INTEGRITY_OWNER}`);
  }
  assert.ok(/export\s+function\s+generateId\b/.test(source), "owner must export generateId");
  assert.ok(/export\s+function\s+generateShortId\b/.test(source), "owner must export generateShortId");
  assert.ok(/export\s+function\s+randomUuid\b/.test(source), "owner must export randomUuid");
  assert.ok(/export\s+function\s+randomBytes\b/.test(source), "owner must export randomBytes");
  assert.ok(/export\s+function\s+sha256\b/.test(source), "owner must export sha256");
  assert.ok(/export\s+function\s+sha256Bytes\b/.test(source), "owner must export sha256Bytes");
});
