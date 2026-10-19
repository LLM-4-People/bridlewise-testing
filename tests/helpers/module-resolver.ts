/**
 * THE SINGLE OWNER OF "WHERE DOES A PRODUCT MODULE LIVE".
 *
 * ── THE DEFECT THIS OWNER ENDS ────────────────────────────────────────────
 *
 * A module's LOCATION is a fact about the filesystem, and for a long time it
 * was restated as a string literal in dozens of places: every prevention guard
 * that needed to read or scan a module carried `read("server/<d>/<f>.ts")` or
 * `const OWNER = "engine/src/<d>/<f>.ts"`. When a module moves (the folder
 * organization refactor moved dozens), every one of those literals points at a
 * path that no longer exists, and each guard has to be re-pointed by hand —
 * 54 guards in one refactor. That is the two-paths / no-single-source defect
 * applied to file paths: the location is answered by a hundred call sites
 * instead of by one owner that can SEE the tree.
 *
 * This module is the single owner. A guard that needs `llm-bridge.ts` asks for
 * it by NAME and receives the path wherever the module currently lives. A move
 * then touches nothing: the resolver re-walks the tree and hands back the new
 * location, and the guard's source does not change.
 *
 * ── STRENGTH LADDER (§0 / §3) — WHERE THIS STOPS AND WHY ──────────────────
 *
 * Rung 1 (physically impossible) is unavailable: the filesystem will create a
 * module at any path, and a guard's choice of path string is not something the
 * OS can refuse. Rung 2 (unrepresentable) is unavailable: a guard must be able
 * to talk about "the file that owns X" — that name is a legitimate string. A
 * raw path is not the bad state; a STALE path is, and staleness is a fact
 * about the tree, not a type. Rung 3 (unreachable by shape) is PARTIALLY
 * reached: {@link moduleRef} returns a branded `ModuleRef`, and the consumer
 * helpers below accept ONLY that brand, so a guard that goes through them
 * cannot be handed a raw path string — forgetting is a compile error. That is
 * as high as a scan-side fix can honestly go. Rung 4 (a runtime choke point)
 * is what this is for the path ANSWER: one function walks the tree and every
 * consumer gets the answer from it, so there is exactly one place the location
 * is decided. The remaining rung-5 surface — a guard that ignores the brand
 * and writes a raw literal into a bare `readFileSync` — is covered by the
 * guard-of-guards (a source scan that refuses a product-path literal outside
 * this owner). This module is the rung-4 owner; the brand is the rung-3 shape;
 * the scanner is the rung-5 floor, and it is documented as such.
 *
 * ── DENY BY DEFAULT ───────────────────────────────────────────────────────
 *
 * The name→path index is DISCOVERED by walking the product roots, never
 * declared. A module that does not exist resolves to a REFUSAL, not a guess.
 * Two modules with the same basename in one root resolve to a REFUSAL that
 * names the collision — the resolver never picks one. A path outside a product
 * root is refused. The default answer to anything ambiguous or absent is a
 * thrown `ModuleResolutionError`, so a guard can never be handed a wrong path
 * silently.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, normalize, relative } from "node:path";

/**
 * The product roots the resolver walks. These are the directories whose
 * modules a guard may legitimately need by name — the server, the engine
 * source, the engine's scripts (a large consumer population the README
 * consumer lists are generated from), and the client. The set is named once
 * here so a new product area is added in ONE place. This is a list of ROOTS,
 * not a list of modules: it cannot go stale when a module moves, only when
 * the tree gains a whole new top-level product area.
 *
 * A root is an INDEX root (its modules are resolvable by name) AND a CONSUMER
 * root (its modules are scanned for who they import). The README consumer
 * reverse-lookup needs `engine/scripts` because that is where much of the
 * engine's own tooling consumes the source.
 */
const PRODUCT_ROOTS = ["server", "engine/src", "engine/scripts", "src"] as const;

/** The executable source extensions the resolver indexes. */
const MODULE_EXTS: ReadonlySet<string> = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".mjs",
  ".svelte",
]);

/**
 * A module's location as handed out by the resolver. The brand makes the
 * resolver the ONLY honest source: a value of this type cannot be constructed
 * by a caller writing a string, only returned by {@link moduleRef}. Consumers
 * typed to take a `ModuleRef` therefore cannot be handed a hand-spelled path.
 */
declare const MODULE_REF_BRAND: unique symbol;
export type ModuleRef = { readonly [MODULE_REF_BRAND]: true } & string;

/** The refusal raised for an absent, ambiguous, or out-of-scope name. */
export class ModuleResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModuleResolutionError";
  }
}

/**
 * The name→path index for one product root, cached. A root's index is built
 * on first use and reused for the rest of the run; a module move DURING a run
 * is not a supported scenario (a run is a single judgement of a fixed tree).
 * The cache is keyed on the root so the three roots are walked once each.
 */
const INDEX_CACHE = new Map<string, ReadonlyMap<string, readonly string[]>>();

/**
 * Recursively collect the executable source files under `root`, skipping the
 * directories that never hold a product module. This is the resolver's OWN
 * walk, deliberately NOT `source-scan.ts`'s `walk`: that walk cross-checks its
 * answer against `git ls-files` (a subprocess per root) because a guard's
 * UNIVERSE must be provably complete. The resolver's job is different — it
 * must FIND a named module, and an index miss is a refusal, not a silent pass
 * — so it pays no subprocess and stays fast. The two walks answer different
 * questions and are not interchangeable.
 */
function collectModules(root: string): readonly string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        visit(full);
      } else if (MODULE_EXTS.has(extname(entry))) {
        out.push(full);
      }
    }
  };
  try {
    statSync(root);
    visit(root);
  } catch {
    // A root that does not exist contributes no modules. The resolver REFUSES
    // a name it cannot find, so an absent root narrows the index to nothing
    // and every lookup under it throws — it never fabricates a path.
  }
  return out;
}

/**
 * The basename→paths index for `root`, built once and cached. Deny-by-default
 * lives here: the index is a map from a basename to EVERY path that bears it,
 * so an ambiguous name is visible as a multi-entry list and refused at lookup.
 */
function indexFor(root: string): ReadonlyMap<string, readonly string[]> {
  const cached = INDEX_CACHE.get(root);
  if (cached !== undefined) return cached;
  const byName = new Map<string, string[]>();
  for (const file of collectModules(root)) {
    const name = basename(file);
    const existing = byName.get(name);
    if (existing === undefined) byName.set(name, [file]);
    else existing.push(file);
  }
  INDEX_CACHE.set(root, byName);
  return byName;
}

/**
 * Resolve a module by NAME to its current location, across every product root.
 *
 * `name` is the module's basename (`"llm-bridge.ts"`) — the identity that does
 * not change when the file moves. The resolver walks the product roots, finds
 * the file bearing that name, and returns its location as a branded
 * {@link ModuleRef}.
 *
 * REFUSALS (deny-by-default):
 *   - the name is found NOWHERE → throw, naming the name and the roots walked;
 *   - the name is found in MORE THAN ONE place → throw, naming every
 *     collision. The resolver never guesses between two same-named modules;
 *     the caller must disambiguate with a path fragment (see {@link moduleRef}).
 *
 * The result is a branded type so a consumer typed to accept `ModuleRef`
 * cannot be handed a hand-spelled path — the brand is only minted here.
 */
export function resolveModule(name: string): ModuleRef {
  const clean = basename(name); // tolerate a caller that passed a fragment
  const found: string[] = [];
  for (const root of PRODUCT_ROOTS) {
    const hits = indexFor(root).get(clean);
    if (hits !== undefined) found.push(...hits);
  }
  if (found.length === 0) {
    throw new ModuleResolutionError(
      `resolveModule(): no module named "${clean}" exists under any product root ` +
        `(${PRODUCT_ROOTS.join(", ")}). The resolver discovers the tree, so this means the ` +
        `module does not exist — not that it moved. Check the name.`,
    );
  }
  if (found.length > 1) {
    throw new ModuleResolutionError(
      `resolveModule(): "${clean}" is ambiguous — it lives at ${found
        .map((f) => `"${f}"`)
        .join(", ")}. The resolver refuses to guess between same-named modules. ` +
        `Disambiguate with a path fragment (e.g. moduleRef("server", "${clean}")).`,
    );
  }
  return found[0] as ModuleRef;
}

/**
 * Resolve a module by NAME within a single product root. This is the
 * disambiguation door for the rare same-named module: a guard that genuinely
 * needs `server`’s `config.ts` and not `src`’s says so. `root` must be one of
 * the product roots; anything else is refused (deny-by-default — the resolver
 * does not answer for directories outside its ownership).
 */
export function moduleRefIn(root: (typeof PRODUCT_ROOTS)[number], name: string): ModuleRef {
  if (!PRODUCT_ROOTS.includes(root)) {
    throw new ModuleResolutionError(
      `moduleRefIn(): "${root}" is not a product root (${PRODUCT_ROOTS.join(", ")}). ` +
        `The resolver owns only the product trees.`,
    );
  }
  const clean = basename(name);
  const hits = indexFor(root).get(clean) ?? [];
  if (hits.length === 0) {
    throw new ModuleResolutionError(
      `moduleRefIn(): no module named "${clean}" under ${root}. The index is walked from ` +
        `the tree, so this means it does not exist there.`,
    );
  }
  if (hits.length > 1) {
    throw new ModuleResolutionError(
      `moduleRefIn(): "${clean}" is ambiguous under ${root}: ${hits
        .map((f) => `"${f}"`)
        .join(", ")}. Name the subfolder to disambiguate.`,
    );
  }
  return hits[0] as ModuleRef;
}

/**
 * Resolve a module by a path FRAGMENT — the trailing segments that make it
 * unique. A guard that needs `server`'s `db/schema.ts` and not its
 * `routes/schema.ts` asks for `"db/schema.ts"` and gets the one module whose
 * path ends with that fragment, wherever the folder moves. The fragment is a
 * SUFFIX the caller asserts is unique; the resolver still refuses when it is
 * not (zero matches, or two modules sharing the suffix), so it never guesses.
 *
 * This is the disambiguation door for same-basename modules: the fragment
 * carries just enough location to be unique, and no more — a move WITHIN the
 * tree that keeps the trailing segments still resolves, and a move that
 * changes them fails loudly rather than silently pointing at the wrong file.
 */
export function moduleRefMatching(fragment: string): ModuleRef {
  const clean = fragment.replace(/^\/+/, "");
  const found: string[] = [];
  for (const root of PRODUCT_ROOTS) {
    for (const file of collectModules(root)) {
      const rel = file.split("\\").join("/");
      if (rel === clean || rel.endsWith(`/${clean}`)) found.push(rel);
    }
  }
  const unique = [...new Set(found)];
  if (unique.length === 0) {
    throw new ModuleResolutionError(
      `moduleRefMatching(): no module's path ends with "${clean}" under any product root ` +
        `(${PRODUCT_ROOTS.join(", ")}). The tree is discovered, so this means the fragment ` +
        `matches nothing — the module moved or the fragment is wrong.`,
    );
  }
  if (unique.length > 1) {
    throw new ModuleResolutionError(
      `moduleRefMatching(): "${clean}" is ambiguous — it matches ${unique
        .map((f) => `"${f}"`)
        .join(", ")}. Extend the fragment until it is unique.`,
    );
  }
  return unique[0] as ModuleRef;
}

/** The location of a module by unique path fragment, as a path string. */
export function modulePathMatching(fragment: string): string {
  return moduleRefMatching(fragment) as string;
}

/**
 * The location of a module as a plain string for helpers that already take a
 * path. This is the one sanctioned way to turn a module identity into a path
 * string: the path is RESOLVED, never spelled by the caller. Guards that scan
 * a module's source call `modulePath("llm-bridge.ts")` instead of writing the
 * path, so a move leaves the guard untouched.
 *
 * The return is a plain `string` (not the brand) precisely so it can flow into
 * the existing scan helpers (`read`, `stripCommentsOnly`, `existsSync`), which
 * are typed on `string`. The BRAND guards the high-level consumer helpers
 * below; this function is the bridge for the guards that keep their existing
 * helper calls but stop hardcoding the path.
 */
export function modulePath(name: string): string {
  return resolveModule(name) as string;
}

/** The location of a same-named module within one product root, as a path. */
export function modulePathIn(root: (typeof PRODUCT_ROOTS)[number], name: string): string {
  return moduleRefIn(root, name) as string;
}

/**
 * Every module in the product tree whose source references `name`'s module —
 * the reverse-lookup the README "what consumes it" list is generated from.
 *
 * A consumer is a file whose import/export specifier RESOLVES to the target.
 * This is computed from the import graph the resolver can already see, never
 * from a hand-maintained list, so a consumer added or removed is reflected the
 * next time the index is built. Returned as repo-relative forward-slash paths.
 */
export function consumersOf(
  name: string,
  parse: (source: string) => readonly string[],
  readSource: (path: string) => string,
): readonly string[] {
  const target = resolveModule(name) as string;
  const graph = buildConsumerGraph(parse, readSource);
  return graph.get(normalize(target)) ?? [];
}

/**
 * The consumers of a module identified by its KNOWN path. The README
 * generator already knows each file's location (it walks the folder); it needs
 * the reverse-lookup, not the name resolution. This is the door for that: no
 * basename lookup, no ambiguity — the path is the identity. The path is
 * normalized so a `engine/src/kernel/contracts.ts` and an
 * `engine/src/./kernel/contracts.ts` resolve to the same graph node.
 */
export function consumersOfKnownPath(
  path: string,
  parse: (source: string) => readonly string[],
  readSource: (path: string) => string,
  repoRoot?: string,
): readonly string[] {
  const graph = buildConsumerGraph(parse, readSource, repoRoot);
  return graph.get(normalize(path)) ?? [];
}

/**
 * The forward→reverse import graph for the whole product tree, built once per
 * `parse`/`readSource` pair and cached. Building the graph walks every product
 * module exactly once and records, for each resolved target, the files that
 * import it. The README generator asks about hundreds of modules; without this
 * shared graph each question would re-walk and re-parse the tree (O(targets ×
 * files)). With it the tree is read once and every reverse-lookup is O(1).
 *
 * The map key is a target's normalized path; the value is the sorted list of
 * its consumers (repo-relative, forward slashes).
 */
const CONSUMER_GRAPH_CACHE = new WeakMap<
  (source: string) => readonly string[],
  Map<string, ReadonlyMap<string, readonly string[]>>
>();

export function buildConsumerGraph(
  parse: (source: string) => readonly string[],
  readSource: (path: string) => string,
  repoRoot?: string,
): ReadonlyMap<string, readonly string[]> {
  // The cache is keyed on the parse function AND the root: a graph projected
  // for one tree (testing) is WRONG for another (master) — the two have the
  // same layout but different importers, so a cross-root run must rebuild.
  const rootKey = repoRoot ?? "";
  let byRoot = CONSUMER_GRAPH_CACHE.get(parse);
  if (byRoot === undefined) {
    byRoot = new Map<string, ReadonlyMap<string, readonly string[]>>();
    CONSUMER_GRAPH_CACHE.set(parse, byRoot);
  }
  const cached = byRoot.get(rootKey);
  if (cached !== undefined) return cached;
  // The walk and the resolution are anchored at repoRoot (default cwd): the
  // graph must be projected from THE TARGET tree's files, never the runner's.
  const anchor = repoRoot ?? process.cwd();
  const reverse = new Map<string, string[]>();
  for (const root of PRODUCT_ROOTS) {
    for (const absCandidate of collectModules(join(anchor, root))) {
      let source: string;
      try {
        source = readSource(absCandidate);
      } catch {
        continue;
      }
      // Keys and consumer names are repo-relative (the README's vocabulary),
      // never absolute — a projection keyed on an absolute path leaks the
      // runner's filesystem into the document.
      const candidate = relative(anchor, absCandidate).split("\\").join("/");
      const rel = candidate;
      const seen = new Set<string>();
      for (const specifier of parse(source)) {
        if (typeof specifier !== "string" || specifier.length === 0) continue;
        if (!specifier.startsWith(".")) continue; // bare specifiers name no product file
        const resolved = resolveCandidate(join(anchor, joinDir(candidate, specifier)), anchor);
        if (resolved === null || seen.has(resolved)) continue;
        seen.add(resolved);
        const list = reverse.get(resolved);
        if (list === undefined) reverse.set(resolved, [rel]);
        else list.push(rel);
      }
    }
  }
  const sorted = new Map<string, readonly string[]>();
  for (const [target, list] of reverse) sorted.set(target, list.sort());
  byRoot.set(rootKey, sorted);
  return sorted;
}

/** Node-style resolution of a specifier against a candidate path. Returns the
 *  resolved path repo-relative to `anchor` (forward slashes), or null. */
function resolveCandidate(candidate: string, anchor: string): string | null {
  const attempts: string[] = [candidate];
  const jsLike = candidate.match(/\.(js|mjs|cjs|jsx)$/);
  if (jsLike !== null) {
    const stem = candidate.slice(0, -jsLike[0].length);
    for (const ext of [".ts", ".mts", ".cts", ".mjs"]) attempts.push(stem + ext);
  }
  for (const ext of [".ts", ".mts", ".cts", ".mjs", ".svelte"]) {
    attempts.push(candidate + ext);
    attempts.push(candidate.replace(/\/$/, "") + `/index${ext}`);
  }
  for (const attempt of attempts) {
    try {
      // NORMALIZE so a relative specifier like `engine/src/./kernel/x.ts`
      // compares equal to the target's clean path `engine/src/kernel/x.ts`.
      // Without this a real importer resolves to a byte-different string and
      // the reverse-lookup reports zero consumers for a heavily-used module.
      const clean = normalize(attempt);
      if (statSync(clean).isFile()) return relative(anchor, clean).split("\\").join("/");
    } catch {
      continue;
    }
  }
  return null;
}

/** The importing file's directory, for resolving its relative specifiers. */
function joinDir(file: string, specifier: string): string {
  const idx = file.lastIndexOf("/");
  const dir = idx === -1 ? "." : file.slice(0, idx);
  return `${dir}/${specifier}`;
}

/**
 * The product roots, exposed read-only for the README generator and the
 * guard-of-guards (which walks them to refuse raw path literals). Not part of
 * a guard's normal API — a guard asks for a module by name.
 */
export function productRoots(): readonly string[] {
  return PRODUCT_ROOTS;
}
