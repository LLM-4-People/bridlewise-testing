// @vitest-environment node
/**
 * THE DEV SERVER CANNOT REACH `engine/**` — through the dep-scanner's entry
 * universe, through the watcher, or through the corpus symlink's home.
 *
 * ── THE DEFECT, MEASURED ────────────────────────────────────────────────
 *
 * Driven on this tree (vite 8.1.5, rolldown), cold start, 2026-07-31: the
 * dependency scanner's DEFAULT entry inference (every `.html` under the
 * project root, recursively) followed `engine/large-codebases` — a symlink to the 4.1 GB
 * vendored corpus — took forty-plus corpus fixtures as entries, and died
 * inside the dotnet wasm template on its literal `main#[.{fingerprint}].js`
 * import placeholder: `(!) Failed to run dependency scan. Skipping
 * dependency pre-bundling.` The watcher's `server.watch.ignored` was
 * already set to ignore the engine subtree and answered the scanner nothing: watching
 * and scanning are two doors, and only one was shut.
 *
 * The fix is the declaration in `vite.config.ts`: `optimizeDeps.entries`
 * OVERWRITES the default inference (the installed version's documented
 * behaviour), so the scanner's universe is the app's pages — the root
 * documents and `src/**` — and `engine/**` is unreachable by shape. This
 * guard certifies the LOADED config's answer, never a re-typed copy of it.
 *
 * ── §41 — WHERE THIS WAS SEARCHED FOR BEFORE IT WAS WRITTEN ───────────────
 *
 * `declared-pattern-liveness.test.ts` was the candidate with the nearest
 * charter, and it certifies exactly one property of a pattern declaration:
 * that every pattern still selects something. It is blind to what a LIVE
 * pattern selects — the recursive-html default was live the day it crawled the corpus and
 * died. Exclusion is a different question, and no guard asked it of the dev
 * server. The §41 answer is no, so this is a new file.
 *
 * ── THE INSTRUMENT IS THE SCANNER'S OWN DIALECT ────────────────────────────
 *
 * The patterns are evaluated with `tinyglobby` — the glob engine vite's
 * scanner itself uses — NOT node:fs `globSync`. Measured on this tree (both
 * engines over the same widened "all-html-recursive" pattern with the corpus
 * symlink present): node:fs reported **11 matches, 0 corpus** (it does not
 * follow the `engine/large-codebases` symlink); tinyglobby reported **283
 * matches, 272 corpus**. A guard that evaluates the entry patterns in node:fs's dialect
 * certifies an exclusion the scanner never enforces — it sees zero corpus
 * files because its own engine cannot reach them, and passes while the real
 * scanner crawls 272. The exclusion question can only be asked in the dialect
 * the scanner actually speaks, so this guard's instrument is tinyglobby's
 * `globSync` over the working tree, the same call the scanner makes.
 *
 * tinyglobby in `devDependencies` is NOT a new runtime dep: it is a
 * prevention-test instrument, never shipped to the dev server, and it is the
 * engine vite already bundles (the version pinned in `devDependencies` is
 * vite's own). The end-to-end boot receipt stays with the fix; this guard is
 * the mechanical tripwire that pattern drift cannot widen the scanner's
 * universe past the corpus.
 */
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { globSync } from "tinyglobby";
import { describe, expect, test } from "vitest";

const ROOT = process.cwd();
// A wildcard BEFORE the corpus symlink forces the scanner to traverse it.
// The known Lodash pages are real corpus data; node:fs glob sees none here.
const CORPUS_HTML_WITNESS = "engine/*/real-20/lodash/test/*.html";
const CORPUS_HTML_BAIT = "engine/large-codebases/real-20/lodash/test/index.html";

type LoadedViteConfig = {
  optimizeDeps?: { entries?: string | string[] };
  server?: { watch?: { ignored?: readonly string[] } };
};

// The build's configuration: what the default export (the config vite loads) answers outside vitest's test mode.
const config = (await import("../../vite.config.ts")).BUILD_CONFIG as LoadedViteConfig;

describe("the dep-scanner's entry universe is the app's pages and nothing else", () => {
  const raw = config.optimizeDeps?.entries;
  const patterns = raw === undefined ? [] : [raw].flat();

  test("the entries are WIRED into the loaded config, not merely declared beside it", () => {
    // The inert shape: a declaration the defineConfig call never receives
    // reads fine in source and changes nothing the scanner does. This guard
    // only ever reads the config the dev server actually loaded.
    expect(
      patterns.length,
      "optimizeDeps.entries is absent from the loaded vite config — the default recursive-html " +
        "inference is active, which is exactly the shape that scanned the corpus",
    ).toBeGreaterThan(0);
  });

  test("every entry pattern selects at least one page, and every page of the app is selected", () => {
    expect(patterns.length).toBeGreaterThan(0);
    const selections = patterns.map((pattern) => ({ pattern, paths: globSync(pattern, { cwd: ROOT }) }));
    const matched = new Set(selections.flatMap(({ paths }) => paths.map((path) => path.split("\\").join("/"))));
    for (const { pattern, paths } of selections) {
      expect(
        paths.length,
        `entry pattern ${JSON.stringify(pattern)} selects nothing — the scanner would pre-bundle less ` +
          `than the app imports`,
      ).toBeGreaterThan(0);
    }
    // The coverage obligation, asked of the filesystem rather than of the
    // patterns: every root document and every client page must be an entry,
    // or the scanner's universe shrank while the patterns stayed live.
    const rootPages = readdirSync(ROOT).filter((entry) => entry.endsWith(".html"));
    const clientPages = globSync("src/**/*.html", { cwd: ROOT }).map((path) => path.split("\\").join("/"));
    expect(
      rootPages.length + clientPages.length,
      "no app pages found at all — this guard's universe is empty and every verdict below is free",
    ).toBeGreaterThan(0);
    for (const page of [...rootPages, ...clientPages]) {
      expect(matched, `the app's page ${page} is not a scanner entry`).toContain(page);
    }
  });

  test("nothing the entries select is outside the root documents and the client tree", () => {
    const matched = patterns.flatMap((pattern) =>
      globSync(pattern, { cwd: ROOT }).map((path) => path.split("\\").join("/")),
    );
    expect(matched.length).toBeGreaterThan(0);
    const escapees = matched.filter((path) => path.includes("/") && !path.startsWith("src/"));
    expect(
      escapees,
      `the scanner's entries reach outside the root documents and src/ — the shape that crawled ` +
        `engine/large-codebases: ${escapees.join(", ")}`,
    ).toEqual([]);
    // A liveness witness needs real symlink traversal, not every HTML in
    // every vendored repository. The old all-tree witness visited 125,893
    // directories / 830,341 entries for 287 HTML matches (14.57 s in this
    // Vitest owner); this pattern reaches the real Lodash bait through the
    // same symlink in 15 directories. It still distinguishes tinyglobby
    // from node:fs globSync. The actual configured selections above remain
    // unconstrained: widening entries still exposes every forbidden match.
    const corpus = join(ROOT, "engine", "large-codebases");
    if (existsSync(corpus)) {
      expect(existsSync(join(ROOT, CORPUS_HTML_BAIT)), "the known real corpus HTML bait must exist").toBe(true);
      const reached = globSync(CORPUS_HTML_WITNESS, { cwd: ROOT });
      expect(reached, "the scanner's dialect must traverse the corpus symlink to the real HTML bait")
        .toContain(CORPUS_HTML_BAIT);
      expect(matched.some((path) => path.startsWith("engine/")), "an entry matched inside engine/").toBe(false);
    }
  });
});

describe("the watcher's door and the corpus's home hold the same line", () => {
  test("the watcher really does ignore engine/**, asked of the loaded config and the real tree", () => {
    const ignored = config.server?.watch?.ignored ?? [];
    expect(
      ignored.length,
      "server.watch.ignored is empty or absent from the loaded config — the 435,410-inotify shape returns",
    ).toBeGreaterThan(0);
    // Semantic, not textual: some declared ignore pattern must match real
    // paths under engine/ on this tree, or the rule quietly stopped reaching
    // its subject. engine/ itself is the liveness floor — it always has
    // tracked files on disk.
    expect(
      readdirSync(join(ROOT, "engine")).length,
      "engine/ is empty — the watcher exclusion has no subject to judge against",
    ).toBeGreaterThan(0);
    // Ask the actual ignore semantics about real subjects at root and
    // nested depths, including the corpus symlink. Materializing an ignore
    // pattern's whole match set previously walked all 830,341 entries.
    // dot:true also exercises the engine's real hidden control files.
    const subjects = globSync(["engine/*", "engine/src/*/*.ts", CORPUS_HTML_WITNESS], { cwd: ROOT, dot: true });
    expect(subjects.length, "the watcher witness must contain actual engine files").toBeGreaterThan(0);
    const unignored = globSync(subjects, { cwd: ROOT, dot: true, ignore: ignored });
    expect(unignored, `watch.ignored must exclude every actual engine witness (declared: ${ignored.join(", ")})`)
      .toEqual([]);
  });

  test("the corpus, when present, lives OUTSIDE this tree — never inside it", () => {
    const link = join(ROOT, "engine", "large-codebases");
    // Absent is a correct state (a fresh clone has no corpus: it is vendored
    // fixture data a machine adds, not tree content). PRESENT, whatever it
    // is — a symlink or a real folder — it must resolve OUTSIDE this tree: a
    // folder copied in place resolves inside it, which is the red this pins
    // (it used to return green for anything but a symlink).
    const present = lstatSync(link, { throwIfNoEntry: false }) !== undefined;
    const target = present ? realpathSync(link) : undefined;
    expect(
      target !== undefined && target.startsWith(`${ROOT}/`),
      `engine/large-codebases resolves to ${target}, INSIDE this tree — the corpus would be watched, ` +
        `scanned and walked as if it were content`,
    ).toBe(false);
  });
});
