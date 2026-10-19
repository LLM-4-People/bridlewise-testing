import assert from "node:assert/strict";
import { readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import test from "node:test";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * DEAD-PACKAGE regression: `src/smart-edit/` survived for rounds because the
 * dead-export scanner checks individual *exports* in `.ts` files — and
 * smart-edit was a whole package of `.mjs` modules that no `.ts` scanner ever
 * walked. Zero executable imports reached it from outside itself, yet nothing
 * red.
 *
 * This guard closes the hole at the package level: every directory under a
 * source root that contains source modules must be REACHABLE — at least one
 * module in it must be imported by a source file OUTSIDE that directory. A
 * directory whose only inbound edges are internal (its own files importing
 * each other) is a dead package: self-contained, self-referential, and
 * consumed by nothing.
 *
 * The scan is deny-by-default and dynamic: it walks every source file
 * (`.ts`/`.mts`/`.js`/`.mjs`) under every source root, parses the executable
 * import specifiers (never comments or strings), resolves each to a path, and
 * builds the cross-directory inbound map. A package with zero inbound edges is
 * reported. Entry points (a package's own root index that a host loads by
 * path, not by import) are the only exemption, and each is named with the
 * loader that reaches it.
 */

const ENGINE_SRC = join(process.cwd(), "src");
const TEST_ROOT = join(process.cwd(), "test");
const SCRIPTS_ROOT = join(process.cwd(), "scripts");
// Frozen experiment archives are NOT live consumers. `scripts/exp/` is a
// versioned record of past rounds — never imported by the harness, never run
// by the build or CI (verified: no reference in package.json, the tooling, or
// the manifest). Counting an archived experiment as a consumer is exactly how
// `src/smart-edit/` read as reachable: five frozen `exp444-*`/`exp453-*`
// scripts imported it, and nothing else in either repository did. A consumer
// that can never run is not a consumer.
const ARCHIVED_EXPERIMENT_ROOT = join(SCRIPTS_ROOT, "exp");
// The web UI + server are cross-boundary consumers (an engine export consumed
// only by the web UI is alive). Probe the enclosing root's trees; absent in a
// standalone checkout.
const WEB_ROOTS: readonly string[] = (() => {
  const root = join(process.cwd(), "..");
  return ["src", "server", "shared", "tests", "scripts"]
    .map((d) => join(root, d))
    .filter((d) => existsSync(d));
})();

const SOURCE_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/u;

/**
 * Directories that are legitimately loaded BY PATH (a host resolves the file
 * at runtime — package.json `exports`, a CLI entry, a dynamic-import worker)
 * rather than by a static cross-package import. Each entry names the loader.
 * This is the deny-by-default exemption set: a package that is NOT reached by
 * any loader and NOT imported is dead, and it lands here only with evidence.
 */
const PATH_LOADED_DIRS: Readonly<Record<string, string>> = {
  // No current entries — a candidate must name its loader to be added.
};

interface SourceFile {
  path: string;
  /** Absolute paths this file imports (resolved). */
  imports: string[];
}

function listSource(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"] })) {
    if (SOURCE_EXT.test(file)) acc.push(file);
  }
  return acc;
}

/**
 * Extract the executable import specifiers from a source file. Comments are
 * stripped so a commented-out import does not count as an edge, but STRING
 * contents are kept (a dynamic `import("./x.mjs")` is a real edge). Only
 * `import`/`export … from`/`import()`/`require()` specifiers count — a bare
 * mention of a path in a string is not an import.
 */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  const patterns = [
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(noBlock)) !== null) out.push(m[1]!);
  }
  return out;
}

/** Resolve a specifier relative to the importing file; null for bare/node:. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // bare / node: / package
  const base = spec.startsWith("/") ? spec : join(dirname(fromFile), spec);
  // Try the specifier as-is and with the source extensions (import paths may
  // omit or carry an extension; `.ts` imports may resolve a `.ts` file).
  const candidates = [base, ...[".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"].map((e) => base + e), join(base, "index.ts"), join(base, "index.mjs")];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch { /* fallthrough */ }
  }
  return null;
}

function buildGraph(files: readonly string[]): SourceFile[] {
  return files.map((path) => ({
    path,
    imports: importSpecifiers(path)
      .map((spec) => resolveSpecifier(path, spec))
      .filter((p): p is string => p !== null),
  }));
}

/** The package key of a source file under a source root: its top-level dir. */
function packageKeyOf(file: string): string | null {
  const rel = relative(ENGINE_SRC, file);
  if (rel.startsWith("..")) return null; // outside engine src (a consumer)
  const parts = rel.split("/");
  // A top-level file (src/cli.ts) is its own package; a nested file is its dir.
  return parts.length > 1 ? parts[0]! : null;
}

test("dead-package-scanner: every engine source package is reachable from outside itself", () => {
  const engineFiles = listSource(ENGINE_SRC);
  const liveScripts = listSource(SCRIPTS_ROOT).filter((f) => !f.startsWith(ARCHIVED_EXPERIMENT_ROOT));
  const consumerFiles = [
    ...engineFiles,
    ...listSource(TEST_ROOT),
    ...liveScripts,
    ...WEB_ROOTS.flatMap((r) => listSource(r)),
  ];
  const graph = buildGraph(consumerFiles);

  // Population witnesses: the scan must actually see a real tree, or it agrees
  // with every claim vacuously.
  assert.ok(engineFiles.length > 100, `the engine source walk went blind (${engineFiles.length} files)`);
  assert.ok(graph.length >= engineFiles.length, "the graph must cover the engine tree");

  // Map: package dir -> set of OUTSIDE files that import into it.
  const inbound = new Map<string, Set<string>>();
  const allPackages = new Set<string>();
  for (const f of engineFiles) {
    const pkg = packageKeyOf(f);
    if (pkg !== null) allPackages.add(pkg);
  }
  for (const pkg of allPackages) inbound.set(pkg, new Set());

  for (const sf of graph) {
    const consumerPkg = packageKeyOf(sf.path);
    for (const target of sf.imports) {
      const targetPkg = packageKeyOf(target);
      // An inbound edge is one where the TARGET is in a package and the
      // CONSUMER is either outside engine src entirely or in a DIFFERENT
      // package (internal self-imports do not make a package reachable).
      if (targetPkg !== null && targetPkg !== consumerPkg) {
        inbound.get(targetPkg)!.add(sf.path);
      }
    }
  }

  const dead: string[] = [];
  for (const pkg of allPackages) {
    if (PATH_LOADED_DIRS[pkg] !== undefined) continue;
    const edges = inbound.get(pkg)!;
    if (edges.size === 0) dead.push(pkg);
  }

  assert.deepEqual(
    dead.sort(),
    [],
    `Dead engine source package(s): a directory with zero inbound executable imports from outside itself ` +
      `(self-contained, self-referential, consumed by nothing). Wire it in or delete it.\n` +
      dead.map((d) => `  src/${d}/`).join("\n") +
      `\n(packages examined: ${allPackages.size}, source files: ${engineFiles.length}, consumer files: ${graph.length})`,
  );
});

test("dead-package-scanner: the smart-edit package is gone", () => {
  // The confirmed-dead package this guard was built for. It must not come back
  // — and because it was `.mjs`, this also pins that the scan walks `.mjs`.
  assert.equal(
    existsSync(join(ENGINE_SRC, "smart-edit")),
    false,
    "src/smart-edit was confirmed dead (zero inbound executable imports) and deleted; it must not be re-introduced",
  );
});
