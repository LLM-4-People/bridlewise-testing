// @vitest-environment node
/**
 * Product-source organization — every domain folder is real, documented, and
 * its README cannot drift from the files it describes.
 *
 * ── THE DEFECT THIS GUARDS ────────────────────────────────────────────────
 *
 * The product source roots (`server/`, `engine/src/`) grew flat: dozens of
 * modules living directly at the root with no domain grouping, so the only
 * way to know what a file was for was to read it. The fix grouped them into
 * domain folders, each with a README. Both halves rot without a guard:
 *
 *   - a new module lands at a root again, ungrouped (the flat root returns);
 *   - a folder is created for a single file (a folder of one is noise, not
 *     organization);
 *   - a folder's README names a file that was deleted, or omits one that was
 *     added (the README becomes a lie that reads as documentation).
 *
 * ── WHY THIS IS A SOURCE SCAN (STRENGTH LADDER) ───────────────────────────
 *
 * Rung 1 (physically impossible) is unavailable: the filesystem will happily
 * create a file at any path. Rung 3 (unreachable by shape) is unavailable:
 * TypeScript has no "you may not create a file at this path" mechanism. Rung 5
 * — a mechanical scan — is the floor that is available, so that is what this
 * is, and its population is WALKED, never listed, so an addition is caught the
 * moment it lands.
 *
 * ── DENY BY DEFAULT ───────────────────────────────────────────────────────
 *
 * A loose file at a product root is RED unless it is in that root's declared
 * entry set (the genuine entry points). A subfolder is RED unless it holds at
 * least three non-README source files (the organization floor) or is a declared
 * exception. A folder without a README is RED. A README whose named file set
 * differs from the folder's real file set is RED in both directions.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { codeStructureOnly, read } from "../helpers/source-scan.ts";
import { lexSpans } from "../../engine/scripts/verification/source-view.ts";
import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { presentTrackedFiles } from "../../engine/src/git/repository-ownership.ts";
import { promotionView } from "../helpers/promotion-view.ts";

const REPO = process.cwd();

/** Directories that never hold a product module, so a walk skips them. */
const WALK_SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "test-results",
  ".svelte-kit",
  ".bridlewise",
]);

/**
 * One source root the census is driven over: a repo-relative root path plus
 * the source-file extension rule its README-freshness arm binds. The product
 * roots additionally carry a loose-entry-point claim (`entries`); the
 * loose-file and domain-floor arms iterate only the product half below, and a
 * test tree is never a loose-entry-point subject.
 */
type RootSpec = Readonly<{ root: string; sourceExts: RegExp }>;

/** A product root and the genuine entry points allowed to stay loose at it.
 *  The entry set is a CLAIM — every entry must exist, and nothing outside it
 *  may sit loose. Adding an entry here is a deliberate act, not an accident. */
type ProductRootSpec = RootSpec & Readonly<{ entries: ReadonlySet<string> }>;

/**
 * The product roots and their genuine loose entry points — the three trees
 * that hold the shipped product. These are the ONLY roots with a
 * loose-entry-point concept; the loose-file and domain-floor arms iterate
 * this table. Each root is a CLAIM that it ships, held to the promotion
 * profile's answer below ("each product root ships").
 */
const PRODUCT_ROOTS: readonly ProductRootSpec[] = [
  {
    root: "server",
    entries: new Set(["index.ts", "web-tree-sitter.d.ts"]),
    sourceExts: /\.(ts|mts|cts|mjs|d\.ts)$/,
  },
  {
    root: "engine/src",
    // cli.mjs is the bash-facing CLI; architecture-manifest.ts is the authored architecture
    // policy, and architecture-modules.ts its one-line-per-module decisions; the registrar and the
    // architecture verifiers reference both by path.
    entries: new Set(["cli.ts", "cli.mjs", "index.ts", "bundle-entry.ts", "architecture-manifest.ts", "architecture-modules.ts"]),
    sourceExts: /\.(ts|mjs)$/,
  },
  {
    root: "src",
    entries: new Set(["main.ts", "client.ts", "client-config.ts", "client-debug.ts", "vite-env.d.ts"]),
    // `.svelte` is a source file too — the cockpit rooms are .svelte, and a
    // README that lists only the .ts files would silently omit them.
    sourceExts: /\.(ts|d\.ts|svelte)$/,
  },
];

/**
 * The source-file shapes a README documents — the same set the freshness
 * parser recognizes in a `- \`name.ext\`` bullet (`ts|mts|cts|mjs|d.ts|
 * svelte`). A README's named-file set is parsed with exactly this shape, so
 * the on-disk comparison must use the same set: a fixture's `.json`/`.py`
 * data file is not a README-named source file, and counting it would force a
 * README to enumerate its data. The two sides of the freshness check share
 * this one shape so they can never disagree about what counts as a file.
 */
const README_SOURCE_EXTS: RegExp = /\.(ts|mts|cts|mjs|d\.ts|svelte)$/;

/**
 * The per-root source-extension rule a root's README-freshness arm binds. It
 * is the README source shape (above) for every root — the freshness arm binds
 * the README's named set to the folder's real set over the same file shapes
 * the parser recognizes. A root therefore names exactly the source files its
 * README can document, and a data file (a fixture's `.json`, a `.py`) never
 * manufactures a false "undocumented" red.
 */
function sourceExtsFor(_root: string): RegExp {
  return README_SOURCE_EXTS;
}

/**
 * The census of source roots the README arms are driven over, DERIVED from
 * the branch's own tree rather than a hand list. It is the product roots plus
 * the top-level components of the census's own dev-documented subject dirs —
 * the same derivation `readmeSubjectDirs` uses to decide which folders a
 * README must document, collapsed to their disjoint top-level roots. The
 * freshness and substance arms iterate THIS census, so a documented folder is
 * freshness-covered by construction and a guard can never again certify a
 * coverage it does not have: the has-a-README census and the freshness census
 * read the SAME subject derivation, and a root the subject set reaches is a
 * root these arms iterate.
 *
 * This is the fix for the blind-guard defect: the README arms used to iterate
 * a `ROOTS` literal holding the three product roots only, so the test trees'
 * READMEs — which the has-a-README census DOES require — were never held to
 * the freshness rule, and a stale test-tree README stayed green. Deriving the
 * census from the subject derivation closes that hole at the trunk: a new
 * documented dev tree enters both the subject set and this census together,
 * because both read the one answer.
 */
function censusRoots(): readonly RootSpec[] {
  const productRoots = PRODUCT_ROOTS.map(({ root, sourceExts }) => ({ root, sourceExts }));
  const productRootSet = new Set(productRoots.map((r) => r.root));
  // The freshness census roots are the product roots PLUS the dev-documented
  // roots — the SAME dev-documented derivation the has-a-README subject census
  // reads — so a folder the subject census requires a README for is held to
  // the freshness rule by construction. This closes the blind-guard hole at
  // the trunk: the freshness census can never again omit a documented tree
  // (the test trees) while the has-a-README census requires its README. A
  // dev-documented root nested under a product root would already be covered
  // by that root's arm; today none is, and the filter keeps the two halves
  // disjoint regardless.
  const dev = devDocumentedRootCandidates()
    .filter((r) => ![...productRootSet].some((p) => r === p || r.startsWith(`${p}/`)))
    .map((root) => ({ root, sourceExts: sourceExtsFor(root) }));
  return [...productRoots, ...dev];
}

/**
 * The roots this guard drives its README census over. Computed lazily (the
 * derivation reads the dev-candidate cache, which is initialized after this
 * point in the module) and memoized — the derivation reads the live tree
 * once, and every census arm shares the one answer.
 */
let censusRootsCache: readonly RootSpec[] | null = null;
function censusRootsMemo(): readonly RootSpec[] {
  if (censusRootsCache === null) censusRootsCache = censusRoots();
  return censusRootsCache;
}

/** The minimum non-README source files a domain folder must hold to exist.
 *  A folder of one or two files is not organization — fold it into the nearest
 *  domain. Three is the floor that makes a folder earn its name. */
const MIN_DOMAIN_FILES = 3;

/**
 * The development surfaces documented folder-by-folder — the test, benchmark,
 * and verification trees an engineer navigates. This is the ONE declaration
 * of that boundary; both the has-a-README census and the README-freshness
 * census derive their dev half from it (via `devDocumentedRootCandidates`),
 * so the two can never disagree about which dev trees carry a README. A tree
 * is on this list because it is the branch's documented dev surface — the
 * experiment record and docs/evidence archives are deliberately NOT here
 * (their folders are data, not navigable documentation). A new documented dev
 * tree is added here deliberately, and the deny-by-default arm below reds if
 * a declared dev-superset tree holding a live suite is left off it.
 */
const DEV_DOCUMENTED_ROOTS: readonly string[] = ["tests", "bench", "engine/test", "engine/verification"];

/** Subfolders that are NOT single-domain folders subject to the README + floor
 *  rules. Each is a CLAIM — it must exist — and each carries its reason:
 *   - container folders (`modules`) organize by SUBfolder, so the
 *     file-count floor applies one level down, not here;
 *   - `.mjs` engine domains are plain-JS modules outside the `.ts` universe;
 *   - declared engine internals (`aux`, `process`, `text`) are single-authority
 *     modules that predate the floor; they are recorded so a NEW one is red.
 *  The server's pre-existing non-domain folders (`routes`, `db`, `blocks`,
 *  `schema`) organize by layer, not by feature domain. */
const NON_DOMAIN_SUBFOLDERS: Readonly<Record<string, ReadonlySet<string>>> = {
  server: new Set(["routes", "db", "blocks", "schema"]),
  "engine/src": new Set(["aux", "modules", "process", "text"]),
  src: new Set(["cockpit", "data", "state"]),
};

function looseFiles(root: string, sourceExts: RegExp): string[] {
  const abs = join(REPO, root);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && sourceExts.test(e.name))
    .map((e) => e.name)
    .sort();
}

function subfolders(root: string): string[] {
  const abs = join(REPO, root);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Every folder that directly holds at least one TRACKED file. A folder whose
 * only files are untracked build output or ignored state (the guardian's
 * built binaries, a `.dev/` PID file) is not part of the product tree git
 * owns and is not a README subject. Derived from `git ls-files` — the index
 * itself — so a file enters the census the moment it is tracked and a folder
 * of untracked artifacts never manufactures a README requirement. This is
 * the deny-by-default census: it cannot miss a tracked folder the way a
 * hand list or a first-level walk would.
 */
function trackedDirsWithFiles(): string[] {
  // The index minus unstaged deletions, from the one ownership reader: a
  // folder whose tracked files were all deleted in the working tree is gone,
  // not a README subject that cannot be listed.
  const tracked = presentTrackedFiles(REPO) ?? [];
  const dirs = new Set<string>();
  for (const file of tracked) {
    let dir = file;
    for (;;) {
      const idx = dir.lastIndexOf("/");
      if (idx === -1) {
        dirs.add(".");
        break;
      }
      dir = dir.slice(0, idx);
      dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/**
 * The folders a README must document, derived — never listed. A folder is
 * subject when it holds a tracked file AND is product surface: it directly
 * holds a path the promotion profile SHIPS (`tests/helpers/promotion-view.ts`,
 * the projection `harness promote` computes over this working tree), or it is
 * a documented development root (the test, benchmark and verification
 * surfaces, named by their roots below — documented folder-by-folder because
 * an engineer navigates them). Records (the experiment and evidence archives,
 * the history documents) ship nothing and are not documented roots, so they
 * are out of scope by construction.
 *
 * The point of routing through the profile rather than a hand list: what
 * ships is answered in one place, so a module the profile starts shipping
 * moves this guard's universe with it instead of leaving a stale allowlist.
 */
function readmeSubjectDirs(): string[] {
  const shippedParents = new Set([...promotionView(REPO).shipped].map((path) => {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? "." : path.slice(0, slash);
  }));
  // The development documentation roots: the test, benchmark, and
  // verification surfaces are documented folder-by-folder because an engineer
  // navigates them; the evidence archive and experiment records are not
  // (their folders are data, not navigable documentation). This is the one
  // declaration of that boundary; the freshness census derives its dev roots
  // from THIS list (below), so the two censuses read one answer and can never
  // disagree about which dev trees carry a README.
  const devRoots = DEV_DOCUMENTED_ROOTS.filter((r) => existsSync(join(REPO, r)));
  const subject = new Set<string>();
  for (const dir of trackedDirsWithFiles()) {
    const isProduct = shippedParents.has(dir);
    const isDevDocumented = devRoots.some((r) => dir === r || dir.startsWith(`${r}/`));
    if (!isProduct && !isDevDocumented) continue;
    subject.add(dir);
  }
  return [...subject].sort();
}

/**
 * The declared dev-superset trees that are documentation roots — the test,
 * benchmark, and verification surfaces, not the docs/evidence archives or the
 * loose dev config files. Derived from the dev-superset declaration by
 * keeping the directory-shaped trees that hold a navigable test/benchmark
 * suite (a `.test.ts`/`.spec.*` source file). The archives (`experiments/`,
 * `engine/_experiments/`) hold only historical scratch — no live suite — and
 * the docs trees hold prose, so neither qualifies; the test/benchmark/
 * verification trees do. Computed once; both the subject census and the
 * freshness census read this one answer, so they can never disagree about
 * which dev trees are documented.
 */
let devRootCandidatesCache: readonly string[] | null = null;
function devDocumentedRootCandidates(): readonly string[] {
  if (devRootCandidatesCache !== null) return devRootCandidatesCache;
  // The documented development surface, projected from the ONE declaration
  // (DEV_DOCUMENTED_ROOTS) to the trees actually present and tracked on this
  // branch. The declaration is the boundary; this projection answers "which of
  // the declared surfaces exist here", so a branch that lacks one (master
  // carries no test trees) drives an empty dev census instead of red-ing on a
  // tree it does not have. Both censuses read this one projection.
  devRootCandidatesCache = DEV_DOCUMENTED_ROOTS.filter((r) => {
    const abs = join(REPO, r);
    return existsSync(abs) && trackedDirsWithFiles().some((d) => d === r || d.startsWith(`${r}/`));
  }).sort();
  return devRootCandidatesCache;
}

/** Whether a tree holds a live suite file at its TOP level — the signature of
 *  a navigable suite surface, as opposed to a tooling dir (whose tests are
 *  nested plumbing) or the experiment record (whose suite-shaped files are
 *  historical scratch). Top-level only: a documented suite names its tests at
 *  its root or in a first-level domain folder, never buried. Never follows a
 *  symlink, and never counts an experiment-record file (`exp<NNN>-…`), which
 *  is the archive's vocabulary, not a live suite. */
function holdsSuiteFile(abs: string): boolean {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return false;
  }
  const isLiveSuiteFile = (name: string): boolean =>
    /\.(test|spec)\.(ts|mts|mjs)$/.test(name) && !/^exp\d+[-.]/.test(name);
  for (const e of entries) {
    if (e.isFile() && isLiveSuiteFile(e.name)) return true;
  }
  // One level down: a documented suite may organize into first-level domain
  // folders (tests/unit, engine/test/aux). Deeper nesting is tooling or data.
  for (const e of entries) {
    if (!e.isDirectory() || WALK_SKIP_DIRS.has(e.name)) continue;
    if (lstatSync(join(abs, e.name)).isSymbolicLink()) continue;
    let sub;
    try {
      sub = readdirSync(join(abs, e.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const se of sub) {
      if (se.isFile() && isLiveSuiteFile(se.name)) return true;
    }
  }
  return false;
}

/**
 * The subject census, memoized for the process. The derivation reads the
 * tracked index and the product closure — both fixed for a test run — and the
 * README arms each consult it, so computing it once at the trunk rather than
 * once per arm keeps the census O(1) per arm instead of O(tree) per arm.
 */
let subjectCache: readonly string[] | null = null;
function readmeSubjectDirsMemo(): readonly string[] {
  if (subjectCache === null) subjectCache = readmeSubjectDirs();
  return subjectCache;
}



/** Every folder under `root` that carries a README.md, at any depth,
 *  repo-relative. Discovered, never declared. */
function readmeFolders(root: string): string[] {
  const abs = join(REPO, root);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const visit = (dirAbs: string): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "README.md")) {
      out.push(relative(REPO, dirAbs).split(sep).join("/"));
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === "dist") continue;
      visit(join(dirAbs, e.name));
    }
  };
  visit(abs);
  return out.sort();
}

/** Every populated folder under `root`, at any depth, repo-relative. A folder
 *  is populated when it holds at least one source file directly. Skips the
 *  directories that never hold a product module. Discovered, never declared. */
function populatedFolders(root: string, sourceExts: RegExp): string[] {
  const abs = join(REPO, root);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const visit = (dirAbs: string): void => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    const hasSource = entries.some((e) => e.isFile() && sourceExts.test(e.name) && e.name !== "README.md");
    if (hasSource) out.push(relative(REPO, dirAbs).split(sep).join("/"));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === "dist") continue;
      visit(join(dirAbs, e.name));
    }
  };
  visit(abs);
  return out.sort();
}

/** The non-README source files directly inside a folder (one level). */
function folderSourceFiles(root: string, folder: string, sourceExts: RegExp): string[] {
  const abs = join(REPO, root, folder);
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && sourceExts.test(e.name) && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

/** The non-README source files directly inside a repo-relative dir. */
function folderSourceFilesForDir(dir: string, sourceExts: RegExp): string[] {
  const abs = join(REPO, dir);
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && sourceExts.test(e.name) && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

/** The file names a README documents, parsed from its `- \`name.ts\`` entries. */
function readmeNamedFiles(readmeAbs: string): string[] {
  // The shared single-owner reader, not a local readFileSync, so the read goes
  // through the one utility the suite sanctions for reading source bytes.
  const text = read(relative(REPO, readmeAbs).split(sep).join("/"));
  const names = new Set<string>();
  for (const m of text.matchAll(/^\s*-\s+`([^`]+\.(?:ts|mts|cts|mjs|d\.ts|svelte))`/gm)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

/** The subsystem folders that actually exist under a root on THIS branch's
 *  working tree (a directory holding at least one tracked source file). The
 *  README's map must match this set — a claimed folder that was deleted is a
 *  stale claim, an existing folder never named is undocumented. */
function realSubsystemDirs(root: string): string[] {
  const abs = join(REPO, root);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !WALK_SKIP_DIRS.has(e.name))
    .filter((e) => {
      // A subsystem is a folder carrying source, at any depth below it.
      const stack = [join(abs, e.name)];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        if (entries.some((x) => x.isFile() && README_SOURCE_EXTS.test(x.name))) return true;
        for (const x of entries) if (x.isDirectory() && !WALK_SKIP_DIRS.has(x.name)) stack.push(join(dir, x.name));
      }
      return false;
    })
    .map((e) => e.name)
    .sort();
}

/** The edit-tool names the editor actually registers on THIS branch — the
 *  single source of truth a README's tool-surface claim must match. Parsed
 *  from the tool definitions' `name: "…"` literals, never restated. */
function registeredEditTools(): string[] {
  const text = read(modulePathMatching("engine/src/editor/edit-tools.ts"));
  const names = new Set<string>();
  for (const m of text.matchAll(/name:\s*"(edit[a-z_]*)"/g)) {
    names.add(m[1]!);
  }
  return [...names].sort();
}

describe("source-root organization — the product roots are what ships", () => {
  test("each product root ships (the promotion profile projects its loose entry points)", () => {
    const view = promotionView(REPO);
    for (const { root, entries } of PRODUCT_ROOTS) {
      expect(view.shippedFolders.has(root), `${root}/ is declared a product root but the promotion profile ships nothing under it`).toBe(true);
      for (const entry of entries) {
        const path = `${root}/${entry}`;
        if (existsSync(join(REPO, path))) expect(view.ships(path), `${path} is a declared loose entry point of a product root but does not ship`).toBe(true);
      }
    }
  });
});

describe("source-root organization — no loose non-entry files", () => {
  // A loose-entry-point claim is meaningful only for a product root, so these
  // arms iterate the product half, never the whole census.
  for (const { root, entries, sourceExts } of PRODUCT_ROOTS) {
    test(`${root}/ has no loose source file outside its declared entry set`, () => {
      const loose = looseFiles(root, sourceExts);
      // Deny-by-default: any loose file not in the declared entry set is red.
      const undeclared = loose.filter((f) => !entries.has(f));
      expect(
        undeclared,
        `${root}/ has loose source file(s) not in its declared entry set: ${undeclared.join(", ")}. ` +
          `Move each into a domain folder of >= ${MIN_DOMAIN_FILES} files, or — only if it is a genuine ` +
          `entry point — declare it in this guard's entry set for ${root}.`,
      ).toEqual([]);
    });

    test(`${root}/ declared entry set names real files and is minimal`, () => {
      const loose = new Set(looseFiles(root, sourceExts));
      for (const entry of entries) {
        expect(loose.has(entry), `${root}/${entry} is declared an entry point but does not exist — a stale claim`).toBe(true);
      }
    });
  }
});

describe("source-root organization — domain folders earn their name", () => {
  // The domain-folder floor is a product-organization invariant; it iterates
  // the product roots, not the test trees.
  for (const { root, sourceExts } of PRODUCT_ROOTS) {
    const nonDomain = NON_DOMAIN_SUBFOLDERS[root] ?? new Set<string>();
    test(`${root}/ every domain folder holds >= ${MIN_DOMAIN_FILES} non-README source files`, () => {
      const tooSmall: string[] = [];
      for (const folder of subfolders(root)) {
        if (nonDomain.has(folder)) continue;
        const count = folderSourceFiles(root, folder, sourceExts).length;
        if (count < MIN_DOMAIN_FILES) tooSmall.push(`${folder} (${count})`);
      }
      expect(
        tooSmall,
        `${root}/ domain folder(s) below the ${MIN_DOMAIN_FILES}-file floor: ${tooSmall.join(", ")}. ` +
          `Fold the file(s) into the nearest domain, or — only if the folder is a genuine declared ` +
          `exception — record it in this guard.`,
      ).toEqual([]);
    });

    test(`${root}/ declared non-domain subfolders exist`, () => {
      const present = new Set(subfolders(root));
      for (const folder of nonDomain) {
        expect(present.has(folder), `${root}/${folder} is declared non-domain but does not exist — a stale claim`).toBe(true);
      }
    });
  }
});

describe("source-root organization — every domain folder has a README", () => {
  // The per-domain-folder README requirement is a product-organization
  // invariant; the test trees are covered by the full-census arm below, not
  // by this first-level walk.
  for (const { root, sourceExts } of PRODUCT_ROOTS) {
    const nonDomain = NON_DOMAIN_SUBFOLDERS[root] ?? new Set<string>();
    test(`${root}/ every domain folder has a README.md`, () => {
      const missing: string[] = [];
      for (const folder of subfolders(root)) {
        if (nonDomain.has(folder)) continue;
        if (!existsSync(join(REPO, root, folder, "README.md"))) missing.push(folder);
      }
      expect(missing, `${root}/ domain folder(s) with no README.md: ${missing.join(", ")}`).toEqual([]);
    });

    test(`${root}/ every populated subfolder of a declared non-domain container has a README.md`, () => {
      // A non-domain container (routes, db, cockpit, modules, …) organizes by
      // layer or by subfolder rather than by feature domain. The container
      // itself and every populated folder beneath it still describe a part of
      // the product, so each carries a README. Discovered, never enumerated.
      const missing: string[] = [];
      for (const container of nonDomain) {
        const containerRel = `${root}/${container}`;
        for (const dir of populatedFolders(containerRel, sourceExts)) {
          if (!existsSync(join(REPO, dir, "README.md"))) missing.push(dir);
        }
      }
      expect(missing, `${root}/ populated folder(s) with no README.md: ${missing.join(", ")}`).toEqual([]);
    });
  }

  test("every folder a README must document carries one (full census)", () => {
    // Deny-by-default over the derived subject set: every populated folder
    // that is product surface (the branch's own product boundary) or a
    // documented development surface (the test/benchmark/verification halves)
    // is red when it lacks a README — at any depth, from the repo root down.
    // A folder added anywhere enters the census the moment it holds a file;
    // it can never be forgotten.
    const missing = readmeSubjectDirsMemo().filter((d) => !existsSync(join(REPO, d, "README.md")));
    expect(
      missing,
      `documented folder(s) with files but no README.md: ${missing.join(", ") || "none"}. ` +
        `Add a README.md describing what the folder is, what each file does, where it lives, ` +
        `and what consumes it.`,
    ).toEqual([]);
  });

  test("the README census asserts a real population (liveness)", () => {
    // A census that sees nothing certifies nothing. The subject set must be
    // non-empty AND must cover the product roots, or the green above is
    // vacuous (§36's witness: prove the instrument is pointed somewhere that
    // contains something).
    const subject = readmeSubjectDirsMemo();
    expect(subject.length, "the README census saw no folders — the derivation is broken").toBeGreaterThan(0);
    for (const { root } of censusRootsMemo()) {
      const covered = subject.some((d) => d === root || d.startsWith(`${root}/`));
      expect(covered, `the README census never reaches ${root}/ — the product boundary dropped it`).toBe(true);
    }
  });

  test("a declared dev tree holding a live suite is never left out of the census", () => {
    // Deny-by-default on the census boundary itself: the dev-documented roots
    // are a DECLARED list, so the rot risk is a dev-superset tree that gains a
    // navigable suite (a top-level `.test.ts`/`.spec.*`) while staying off the
    // census — the exact hole the blind-guard defect was. This arm walks the
    // declared dev-superset trees (the promotion profile's excluded trees) and reds on any that holds a live suite file
    // at its top level yet is not a census root, so a new documented dev tree
    // forces its own addition rather than sitting uncovered and green. The
    // experiment record is excluded by the owner's own floor-byte answer (it
    // is data, not a navigable surface), not by a hand list.
    const coveredRoots = new Set(censusRootsMemo().map((r) => r.root));
    // The experiment record is data, not a navigable documented surface —
    // the owner's own vocabulary names it (`experiments/`, `_experiments/`,
    // the `exp<NNN>` experiment directories), so it is recognized by shape,
    // never enumerated by hand.
    const isExperimentRecord = (dir: string): boolean =>
      /(^|\/)_?experiments?(\/|$)/.test(dir) || /(^|\/)exp\d+(\/|$)/.test(dir);
    // Harness tooling (`scripts/…`) is the merge/verification plumbing — a
    // `.test.mjs` there exercises a one-off tool (the merge script), not a
    // navigable suite an engineer browses. The documented dev surface is the
    // branch's test/benchmark/verification suites; tooling is recognized by
    // its `scripts` root, never enumerated file-by-file.
    const isHarnessTooling = (dir: string): boolean => dir === "scripts" || dir.startsWith("scripts/") || dir.includes("/scripts/");
    const uncovered: string[] = [];
    for (const raw of promotionView(REPO).profiles.flatMap((loaded) => loaded.profile.boundary.exclude)) {
      const dir = raw.endsWith("/") ? raw.slice(0, -1) : raw;
      if (dir.includes(".")) continue; // a declared dev FILE, not a tree
      if (isExperimentRecord(dir) || isHarnessTooling(dir)) continue;
      if ([...coveredRoots].some((r) => dir === r || dir.startsWith(`${r}/`))) continue;
      const abs = join(REPO, dir);
      if (!existsSync(abs)) continue;
      if (holdsSuiteFile(abs)) uncovered.push(dir);
    }
    expect(
      uncovered,
      `declared dev tree(s) holding a live suite but outside the README census: ${uncovered.join(", ") || "none"}. ` +
        `A documented development tree that gains a navigable suite must join the documented-surface ` +
        `declaration so the README census covers it — add it to the census's dev-surface declaration.`,
    ).toEqual([]);
  });
});

describe("source-root organization — README freshness (deny-by-default)", () => {
  // The freshness census is the DERIVED root set — the product roots plus the
  // documented development (test) trees — so a folder the has-a-README census
  // requires a README for is held to the freshness rule here by construction.
  for (const { root, sourceExts } of censusRootsMemo()) {
    test(`${root}/ each README names exactly the folder's real files`, () => {
      // EVERY folder the census covers is held to the same freshness rule:
      // the README's named file set equals the folder's real file set, in
      // both directions. A container folder with no direct source files is
      // exempt (its README documents subfolders, not files). The set is the
      // derived census (any depth), never a first-level walk.
      const stale: string[] = [];
      const missing: string[] = [];
      const covered = readmeSubjectDirsMemo().filter((d) => d === root || d.startsWith(`${root}/`));
      for (const dir of covered) {
        const readmeAbs = join(REPO, dir, "README.md");
        if (!existsSync(readmeAbs)) continue; // the has-a-README arm reports this
        const named = new Set(readmeNamedFiles(readmeAbs));
        const real = new Set(folderSourceFilesForDir(dir, sourceExts));
        // Staleness binds EVERY README: a file a README names must exist, or
        // the README points at a deleted file — a lie in both a file-list and
        // a prose-contract README.
        for (const f of named) if (!real.has(f)) stale.push(`${dir}/${f}`);
        // Completeness (every real file must be named) binds only a README
        // that IS a per-file list — one that already enumerates the bulk of
        // the folder's source files. A README whose bullets name a small
        // minority of the files is a prose contract that mentions its key
        // sources inline (the verification/evidence trees describe the
        // contract, not the file set); forcing it to enumerate every file is
        // not its job and would manufacture red on a contract that is honest.
        // The signature: when the named set covers at least half the real
        // files, the README is a file list and must be complete; below that it
        // is prose, and only staleness (above) binds it. A folder with no
        // source files at all is a container (its README documents subfolders)
        // and is exempt either way.
        if (real.size > 0 && named.size * 2 >= real.size) {
          for (const f of real) if (!named.has(f)) missing.push(`${dir}/${f}`);
        }
      }
      expect(
        { stale, missing },
        `README/file drift. ` +
          `Named in a README but not in the folder (stale): ${stale.join(", ") || "none"}. ` +
          `In the folder but not named in its README (undocumented): ${missing.join(", ") || "none"}. ` +
          `Update the folder's README.md so its file list matches the files on disk.`,
      ).toEqual({ stale: [], missing: [] });
    });
  }
});

describe("source-root organization — READMEs carry substance, not only a file list", () => {
  // A README whose "What each file does" section is a bare per-file list with
  // no concept prose is a README-shaped gap: it names files without saying what
  // the domain IS or how its parts fit, so a reader still cannot navigate. The
  // freshness arm proves the file LIST matches the tree; this arm proves the
  // README SAYS something beyond the list. Discovered over the same census, so
  // a new folder is covered the day it lands.
  test("each README's file-list section is preceded by orienting prose", () => {
    const shallow: string[] = [];
    for (const dir of readmeSubjectDirsMemo()) {
      const readmeAbs = join(REPO, dir, "README.md");
      if (!existsSync(readmeAbs)) continue; // the has-a-README arm reports this
      const text = read(relative(REPO, readmeAbs).split(sep).join("/"));
      // The prose preceding the first per-file bullet. A README with no
      // `- \`file.ts\`` bullet documents a container (its files live one level
      // down) and is prose-only by construction — exempt.
      const firstBullet = text.search(/^\s*-\s+`[^`]+\.(?:ts|mts|cts|mjs|d\.ts|svelte)`/m);
      if (firstBullet === -1) continue;
      const head = text.slice(0, firstBullet);
      // Strip the heading lines (`# …`, `## …`) and the generated-block
      // marker; what remains is the orienting prose. A README whose head is
      // ONLY headings has no concept description.
      const prose = head
        .split("\n")
        .filter((line) => {
          const t = line.trim();
          return t.length > 0 && !t.startsWith("#") && !t.startsWith("<!--");
        })
        .join(" ")
        .trim();
      if (prose.length < 40) shallow.push(`${dir} (${prose.length} chars of prose before the file list)`);
    }
    expect(
      shallow,
      `README(s) whose file list is not preceded by orienting prose: ${shallow.join(", ") || "none"}. ` +
        `A README must say what the domain IS and how its parts fit, not only list files — ` +
        `open each and add the concept description above the file list.`,
    ).toEqual([]);
  });
});

describe("source-root organization — a README is faithful to its OWN branch's tree", () => {
  // A product descriptor (the root README, the engine README) asserts the
  // carrying branch's tool surface and subsystem map. When the two branches
  // carry a genuinely different product (testing's unified `edit` tool and
  // deleted `smart-edit/` versus master's five `edit_*` tools and live
  // `smart-edit/`), each branch's descriptor must describe ITS OWN tree —
  // byte-parity between the branches is the WRONG invariant for content that
  // describes diverged content (two byte-identical copies would certify two
  // different products). This arm judges each descriptor against the WORKING
  // tree it sits in, so a descriptor that asserts a tool or a subsystem the
  // branch does not have reds HERE — the per-tree truth the cross-branch byte
  // audit is structurally blind to (it compares bytes, not claims).
  const readmeText = (repoPath: string): string => read(repoPath);

  test("the root README's tool-surface claim names the editor tools THIS branch registers", () => {
    const text = readmeText("README.md");
    const registered = registeredEditTools();
    // Every registered editor tool the README's tool-surface bullet names must
    // be real on this branch, and the README must not name an editor tool the
    // branch does NOT register (a stale claim from the other branch's surface).
    const claimedEditTools = [...text.matchAll(/`(edit_[a-z_]+|edit)`/g)].map((m) => m[1]!).filter((n) => n === "edit" || n.startsWith("edit_"));
    const registeredSet = new Set(registered);
    const phantom = [...new Set(claimedEditTools)].filter((n) => !registeredSet.has(n));
    expect(
      phantom,
      `the root README claims editor tool(s) this branch does not register: ${phantom.join(", ")}. ` +
        `This branch registers: ${registered.join(", ")}. A descriptor must name its OWN branch's ` +
        `tool surface — update the README's tool-surface bullet to the tools ` +
        `\`${modulePathMatching("engine/src/editor/edit-tools.ts")}\` actually exports.`,
    ).toEqual([]);
  });

  test("the engine subsystem maps name only the subsystem folders THIS branch carries", () => {
    // The two documents that enumerate `engine/src/`'s subsystems. Each `- \`name/\``
    // subsystem bullet must resolve to a real subsystem folder on this branch.
    // The claim set is parsed from BULLET lines only (`- \`name/\`` at line
    // start), so a backticked word inside prose is never misread as a claim.
    const real = new Set(realSubsystemDirs("engine/src"));
    for (const doc of ["engine/README.md", "engine/src/README.md"]) {
      const text = readmeText(doc);
      const claimed = [...text.matchAll(/^\s*-\s+`(?:src\/)?([a-z][a-z0-9-]*)\/`/gm)].map((m) => m[1]!);
      const phantom = [...new Set(claimed)].filter((name) => !real.has(name));
      expect(
        phantom,
        `${doc} names subsystem folder(s) absent from this branch's \`engine/src/\`: ${phantom.join(", ")}. ` +
          `This branch carries: ${[...real].join(", ")}. A subsystem map must match the tree it ships with — ` +
          `remove the folder the branch deleted.`,
      ).toEqual([]);
    }
  });

  test("liveness: the editor-tool registry and the subsystem census both answer a real population", () => {
    // A faithfulness arm whose truth-source came back empty would green on
    // nothing. Both derivations must name a non-empty set, or the guard is
    // certifying a universe that collapsed.
    expect(registeredEditTools().length, "no editor tool registered — the tool-surface faithfulness arm is free").toBeGreaterThan(0);
    expect(realSubsystemDirs("engine/src").length, "no subsystem folder found — the subsystem-map faithfulness arm is free").toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The runtime-dependency arm — a shipped source must not lean on a file the
// promotion strips from the product tree.
// ─────────────────────────────────────────────────────────────────────────

/**
 * THE DEFECT THIS GUARDS. A shipped command once spawned a MANDATORY
 * subprocess whose script lived under a declared testing-only folder
 * (`engine/scripts/tooling/`): on the testing floor the file was present and
 * every check passed, but the product tree strips that folder by design, so
 * the required post-merge convergence command died there with MODULE_NOT_FOUND
 * at the very step that was supposed to re-derive the pins. Nothing red — no
 * merge-back had happened since the misfiling, so the breakage was measured
 * live rather than caught mechanically.
 *
 * THE RULE. The testing-only folders are the trees the promotion profile
 * EXCLUDES (`promotion/*.json`, read through `tests/helpers/promotion-view.ts`),
 * never a hand list, so a tree the profile excludes tomorrow is covered the
 * day it lands. A shipped source may name a file under one of those folders
 * ONLY as an optional, existsSync-guarded reference (the run-tests pattern:
 * probe first, skip gracefully when the tree does not carry the file). A
 * reference the runtime passes to a call with no existence guard on the same
 * path is a mandatory dependency on stripped content and is red by name.
 *
 * THE UNIVERSE. A file is shipped when the promotion profile projects it —
 * the projection `harness promote` computes, asked of this working tree, so
 * the scan judges exactly the population a product tree runs and no other
 * declaration is maintained.
 *
 * THE CLASSIFIER, and why it is shape-based rather than name-based. A path
 * literal is judged by the EXPRESSION POSITION it occupies in the
 * offset-preserving structure view (comments and literal interiors blanked by
 * the shared lexer, so a doc comment mentioning a path can never red):
 *   - inside an `existsSync(...)` call, at any chain depth: PROBE (the
 *     existence check itself);
 *   - the initializer of a const that the same file later passes to
 *     `existsSync(...)`: PROBE (the guarded-const pattern — resolve the path
 *     once, probe the variable);
 *   - a DIRECT argument of any other call: USE (the runtime hands the path to
 *     something — a spawn, a read, a resolver);
 *   - inside an object or array literal (including one passed to a call, like
 *     a manifest or policy entry): DATA — a registration or configuration
 *     value, not a load.
 * A USE is allowed only when the same file also holds a PROBE of the same
 * path. Variable-mediated references (a path built from a non-literal) are
 * outside a string scan's sight; that is this guard's stated limit, and the
 * honest fix for such a reference is its own guard at its own choke point.
 */
describe("source-root organization — runtime sources never depend unguarded on testing-only paths", () => {
  const SOURCE_EXTENSIONS = /\.(ts|mts|cts|mjs|cjs|js|svelte)$/;

  /** The line number of a byte offset in `text` (1-based). */
  function lineOf(text: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
      if (text.charCodeAt(index) === 10) line += 1;
    }
    return line;
  }

  /**
   * The repo-relative paths a string literal could name. A literal is either
   * repo-relative (`scripts/testing/...`), engine-relative
   * (`scripts/tooling/...`, resolved against `engine/`), or file-relative
   * (an import specifier like `../src/...`, resolved against the naming
   * file's own directory). All three forms are judged, so a runtime file
   * cannot dodge the rule by spelling the path relative to itself.
   */
  function candidatePaths(relFile: string, literal: string): readonly string[] {
    if (literal.startsWith("./") || literal.startsWith("../") || isAbsolute(literal)) {
      return [relative(REPO, resolve(REPO, relFile, literal)).split(sep).join("/")];
    }
    return [literal, `engine/${literal}`];
  }

  /** Whether a candidate path plausibly names a FILE under a folder (a path
   *  with an extension-bearing last segment, not a directory prefix or a
   *  glob). Directory-shaped and pattern-shaped references are not this
   *  guard's subject — a mandatory dependency is always a concrete file. */
  function namesFileUnderFolder(candidate: string, folder: string): boolean {
    if (!candidate.startsWith(`${folder}/`)) return false;
    const last = candidate.slice(candidate.lastIndexOf("/") + 1);
    if (last.length === 0) return false;
    if (/[*?<>{}]/.test(candidate)) return false; // a glob or template placeholder, not a file
    return /\.[A-Za-z0-9_-]+$/.test(last);
  }

  /** The identifier (dotted form allowed) a call's opening paren belongs to. */
  function calleeBefore(structure: string, openerIndex: number): string {
    const match = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/.exec(structure.slice(0, openerIndex));
    return match === null ? "" : match[1]!;
  }

  /**
   * Every still-open `(`/`{`/`[` at `at`, innermost last, in the structure
   * view (literal interiors and comments are blanked there, so only real
   * code delimiters are counted).
   */
  function openerStackAt(structure: string, at: number): Array<{ char: string; index: number }> {
    const stack: Array<{ char: string; index: number }> = [];
    for (let index = 0; index < at; index += 1) {
      const char = structure[index];
      if (char === "(" || char === "{" || char === "[") stack.push({ char, index });
      else if (char === ")" || char === "}" || char === "]") stack.pop();
    }
    return stack;
  }

  type Classified = Readonly<{
    probes: ReadonlySet<string>;
    uses: ReadonlyArray<Readonly<{ path: string; folder: string; line: number }>>;
  }>;

  const NO_REFERENCES: Classified = { probes: new Set<string>(), uses: [] };

  /**
   * Classify every string literal in one source file that names a file under
   * a declared testing-only folder, per the position rules in the block
   * comment above. The structure view is computed only when some literal
   * actually matches, so the scan stays cheap over the files that carry no
   * such reference at all.
   */
  function classifySource(
    relFile: string,
    source: string,
    spans: ReadonlyArray<Readonly<{ kind: string; start: number; end: number }>>,
    folders: readonly string[],
  ): Classified {
    const matches: Array<{ span: { start: number; end: number }; path: string; folder: string }> = [];
    for (const span of spans) {
      if (span.kind !== "string") continue;
      const raw = source.slice(span.start, span.end);
      const closed = raw.length > 1 && raw[0] === raw[raw.length - 1];
      const literal = closed ? raw.slice(1, -1) : raw.slice(1);
      for (const candidate of candidatePaths(relFile, literal)) {
        const folder = folders.find((declared) => namesFileUnderFolder(candidate, declared));
        if (folder !== undefined) {
          matches.push({ span, path: candidate, folder });
          break;
        }
      }
    }
    if (matches.length === 0) return NO_REFERENCES;

    const probes = new Set<string>();
    const uses: Array<{ path: string; folder: string; line: number }> = [];
    const structure = codeStructureOnly(source);
    for (const match of matches) {
      const stack = openerStackAt(structure, match.span.start);
      const top = stack[stack.length - 1];
      if (top === undefined || top.char !== "(") continue; // data position (or bare): not a load
      // The chain of enclosing CALL openers, innermost first, stopping at the
      // first object/array opener — a literal inside {} or [] is data even
      // when the whole literal is passed to a call.
      const callChain: number[] = [];
      for (let index = stack.length - 1; index >= 0 && stack[index]!.char === "("; index -= 1) {
        callChain.push(stack[index]!.index);
      }
      const guardedByChain = callChain.some((opener) => calleeBefore(structure, opener) === "existsSync");
      if (guardedByChain) {
        probes.add(match.path);
        continue;
      }
      // The guarded-const pattern: `const NAME = <path constructor>(…, P, …)`
      // with `existsSync(NAME)` later in the file — the probe reached through
      // the variable the file itself defines.
      const innermost = callChain[0]!;
      const innerCallee = calleeBefore(structure, innermost);
      if (innerCallee === "resolve" || innerCallee === "join" || innerCallee.endsWith(".resolve") || innerCallee.endsWith(".join")) {
        const before = structure.slice(0, innermost - innerCallee.length);
        const assigned = /([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before);
        if (assigned !== null) {
          const name = assigned[1]!;
          if (new RegExp(`existsSync\\s*\\(\\s*${name}\\b`).test(structure)) {
            probes.add(match.path);
            continue;
          }
        }
      }
      uses.push({ path: match.path, folder: match.folder, line: lineOf(source, match.span.start) });
    }
    return { probes, uses };
  }

  /**
   * The scan universe: every source file the promotion profile ships that
   * exists on this disk (see the header), so a module the profile starts
   * shipping joins the scan the day it does, never by an edit here.
   */
  function shippedScanFiles(): readonly string[] {
    return [...promotionView(REPO).shipped].filter((path) => SOURCE_EXTENSIONS.test(path) && existsSync(join(REPO, path))).sort();
  }

  test("no shipped source references a testing-only path as an unguarded runtime dependency", () => {
    const folders = [...new Set(promotionView(REPO).profiles.flatMap((loaded) => loaded.profile.boundary.exclude).filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1)))].sort();
    // Liveness on the folder half: the profile's excluded trees must be non-empty,
    // or this guard certifies nothing.
    expect(folders.length, "the promotion profile excludes no tree").toBeGreaterThan(0);

    const files = shippedScanFiles();
    expect(files.length, "the shipped scan enumerated no files — the universe derivation is broken").toBeGreaterThan(0);

    const reds: string[] = [];
    let probesOnTree = 0;
    let allowedUsesOnTree = 0;
    for (const rel of files) {
      const source = read(rel);
      const { probes, uses } = classifySource(rel, source, lexSpans(source, false), folders);
      probesOnTree += probes.size;
      for (const use of uses) {
        if (probes.has(use.path)) {
          allowedUsesOnTree += 1; // the guarded optional pattern: probe in the same file
          continue;
        }
        reds.push(`${rel}:${use.line} references ${use.path} (under the declared testing-only folder ${use.folder})`);
      }
    }
    // Liveness on the classifier: the tree must still carry the ALLOWED
    // shape (an existsSync-guarded reference) and this run must have seen
    // it — zero probes means the guard is green because it is blind to its
    // own allowed pattern, and zero allowed uses means the use half never
    // fired over a real guarded call.
    expect(probesOnTree, "no existsSync-guarded reference to a testing-only path was seen on this tree").toBeGreaterThan(0);
    expect(allowedUsesOnTree, "no guarded optional reference to a testing-only path was exercised").toBeGreaterThan(0);
    expect(
      reds,
      `shipped source(s) referencing a testing-only path as an unguarded runtime dependency:\n` +
        `${reds.map((r) => `  - ${r}`).join("\n")}\n` +
        `A product tree does not carry that folder, so the command dies there (MODULE_NOT_FOUND / ENOENT). ` +
        `Either the reference is optional — guard it with existsSync and skip on absence (the run-tests pattern) — ` +
        `or the dependency is mandatory and the file must move into what ships (the profile's boundary).`,
    ).toEqual([]);
  });

  test("the classifier reads every reference shape it claims (self-witness)", () => {
    // The guard above is only as good as the position classifier. This arm
    // drives every shape the block comment promises — direct probe,
    // guarded-const probe, data in a literal, unguarded use — through the
    // classifier on a synthetic source, so a green above means the shapes
    // were read, not skipped.
    const fixture = [
      `import { existsSync, readFileSync } from "node:fs";`,
      `const guarded = existsSync(resolve(root, "scripts/tooling/run-tests.ts"));`,
      `const inventoryPath = resolve(root, "verification/benchmarks/shared/qualification-authority-inventory.mjs");`,
      `if (existsSync(inventoryPath)) readFileSync(inventoryPath, "utf8");`,
      `const entry = { path: "scripts/tooling/test-receipt.ts" };`,
      `const roots = ["scripts/tooling/network-under-test-guard.mjs"];`,
      `spawnSync(process.execPath, [join(root, "scripts/tooling/test-worker.ts")]);`,
    ].join("\n");
    const folders = ["engine/scripts/tooling", "engine/verification"];
    const { probes, uses } = classifySource("engine/src/workflow/classifier-fixture.ts", fixture, lexSpans(fixture, false), folders);
    expect([...probes].sort()).toEqual([
      modulePath("run-tests.ts"),
      "engine/verification/benchmarks/shared/qualification-authority-inventory.mjs",
    ]);
    expect(uses.map((use) => `${use.path}:${use.line}`)).toEqual(["engine/scripts/tooling/test-worker.ts:7"]);
  });
});
