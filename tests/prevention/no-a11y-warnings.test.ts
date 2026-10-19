// @vitest-environment node
/**
 * Mechanical enforcement: ZERO Svelte compiler warnings across EVERY
 * `.svelte` file (the deferred-a11y bug class).
 *
 * Prior agents (–) deferred a11y + css_unused_selector +
 * state_referenced_locally warnings as "pre-existing / out of scope"* PROHIBITED by. This test makes that deferral IMPOSSIBLE to repeat:
 * it compiles every `.svelte` file in `src/` with the Svelte compiler and
 * fails if ANY warning is emitted.
 *
 * Why the Svelte compiler (not `tsc`): `npm run typecheck` runs `tsc`, which
 * does NOT surface Svelte a11y/CSS/deprecation warnings — those come from the
 * Svelte compiler (`svelte/compiler`'s `compile`). The prior agents' grep of
 * `typecheck` output saw nothing because tsc never emits them. This test uses
 * the authoritative source: the Svelte compiler itself.
 *
 * DYNAMIC discovery: all `.svelte` files
 * under `src/` are discovered via a `readdirSync` walk. A new `.svelte` file
 * is automatically covered — if it introduces a warning, this test fails.
 * Deny-by-default: a file is checked unless explicitly excluded (none are).
 *
 * The contract: every warning must be FIXED, or — only for genuine
 * false positives (e.g. `aria-query` misclassifying `separator`/
 * `application` as non-interactive) — explicitly suppressed with a
 * `<!-- svelte-ignore <code> -->` comment that is justified by a preceding
 * explanation comment. `svelte-ignore` removes the warning before it
 * reaches `warnings`, so a justified suppression passes this test; an
 * un-justified new warning fails it. This forces every warning to be a
 * deliberate decision, never a silent deferral.
 *
 * Mutation-verified: reintroducing any of the fixed warnings (e.g. reverting
 * the ToolsPanel `<li onclick>` to a bare click handler, or removing a
 * `svelte-ignore` from the ResizeDivider separator) makes this test FAIL
 * with the exact file:line:code of the regression.
 */
import { describe, test, expect, afterAll } from "vitest";
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { compile } from "svelte/compiler";
import { stripCommentsAndStringsFor } from "../helpers/source-scan.ts";

const SRC_ROOT = join(process.cwd(), "src");

// Content-hash cache: the Svelte compiler is expensive (each .svelte file is
// parsed + analyzed). Recompiling all 70 files every run costs ~470ms. This
// cache persists the compiled warnings per file content hash to disk; on a
// rerun with unchanged source, the compile is skipped entirely (cache hit).
// The cache lives at .bridlewise/svelte-a11y-cache.json (gitignored). A
// source edit invalidates only the edited file's entry (the hash changes);
// all other entries remain valid. This does NOT weaken the test — the
// warnings are still fully verified on the first run after any source change.
const A11Y_CACHE_PATH = join(process.cwd(), ".bridlewise", "svelte-a11y-cache.json");

interface CachedWarningSummary {
  file: string;
  hash: string;
  warnings: { line: number; code: string; message: string }[];
}

function loadA11yCache(): Map<string, CachedWarningSummary> {
  const cache = new Map<string, CachedWarningSummary>();
  if (!existsSync(A11Y_CACHE_PATH)) return cache;
  try {
    const parsed: unknown = JSON.parse(readFileSync(A11Y_CACHE_PATH, "utf8"));
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (entry && typeof entry === "object" && "file" in entry && "hash" in entry) {
          cache.set(entry.file as string, entry as CachedWarningSummary);
        }
      }
    }
  } catch {
    // A corrupt cache is not evidence; start fresh.
  }
  return cache;
}

const a11yCache = loadA11yCache();
const a11yCacheUpdates = new Map<string, CachedWarningSummary>();

function saveA11yCache(): void {
  try {
    mkdirSync(join(process.cwd(), ".bridlewise"), { recursive: true });
    const merged = new Map(a11yCache);
    for (const [k, v] of a11yCacheUpdates) merged.set(k, v);
    writeFileSync(A11Y_CACHE_PATH, JSON.stringify([...merged.values()]));
  } catch {
    // A cache write failure must not break the test run.
  }
}

/** Recursively collect every `.svelte` file under `src/`. Skips nothing under src/ — deny-by-default. */
function discoverSvelteFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Skip non-source artifacts that may live under src/ in some setups.
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      discoverSvelteFiles(full, acc);
    } else if (entry.name.endsWith(".svelte")) {
      acc.push(full);
    }
  }
  return acc;
}

/** A discovered component + any warnings its source compiles to. */
type WarningSummary = {
  file: string;
  warnings: { line: number; code: string; message: string }[];
};

/** Compile one `.svelte` file's source and collect its warnings. Uses the
 * same compiler the build uses; `warningFilter: () => true` surfaces every
 * warning (a `svelte-ignore` comment removes one BEFORE this filter, so a
 * justified suppression does not appear here). Results are cached per
 * content hash so a rerun with unchanged source skips the compile. */
function compileWarnings(absPath: string): WarningSummary {
  const rel = relative(process.cwd(), absPath);
  const source = readFileSync(absPath, "utf8");
  const hash = createHash("sha256").update(source, "utf8").digest("hex");
  const cached = a11yCache.get(rel);
  if (cached && cached.hash === hash) {
    return { file: rel, warnings: cached.warnings };
  }
  const result = compile(source, {
    filename: absPath,
    generate: false,
    name: "Comp",
    css: "external",
    warningFilter: () => true,
  });
  const warnings = (result.warnings ?? []).map((w) => ({
    line: w.start?.line ?? 0,
    code: w.code,
    message: w.message.replace(/\s+/g, " ").trim(),
  }));
  a11yCacheUpdates.set(rel, { file: rel, hash, warnings });
  return { file: rel, warnings };
}

describe("no Svelte compiler warnings (a11y / css_unused / deprecation)", () => {
  const files = discoverSvelteFiles(SRC_ROOT);

  afterAll(() => {
    // Persist the cache so the next run skips compiling unchanged files.
    saveA11yCache();
  });

  test("at least one.svelte file is discovered (sanity — discovery is not silently empty)", () => {
    // Guards against a path/walk regression that would make the zero-warning
    // assertion vacuously pass by checking nothing.
    expect(files.length, "expected to discover .svelte files under src/").toBeGreaterThan(0);
  });

  test("every.svelte file compiles with ZERO warnings", () => {
    const all: WarningSummary[] = files.map(compileWarnings);
    const offenders = all.filter((s) => s.warnings.length > 0);
    if (offenders.length > 0) {
      const detail = offenders
        .map((s) =>
          s.warnings
            .map((w) => `  ${s.file}:${w.line} [${w.code}] ${w.message}`)
            .join("\n"),
        )
        .join("\n");
      const byCode = new Map<string, number>();
      for (const s of offenders) for (const w of s.warnings) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
      const summary = [...byCode.entries()].map(([c, n]) => `${c}: ${n}`).join(", ");
      throw new Error(
        `Svelte compiler warnings must be ZERO (fix the warning, or — only for a ` +
          `genuine false positive — suppress with a justified ` +
          `<!-- svelte-ignore <code> --> comment). ${offenders.length} file(s) ` +
          `with warnings (${summary}):\n${detail}`,
      );
    }
    expect(offenders, "no .svelte file may emit a compiler warning").toEqual([]);
  });

  test("no.svelte file uses the deprecated `<svelte:self>` (use self-imports)", () => {
    // The svelte_self_deprecation was deferred by a prior agent. The compiler check above would catch a live usage, but this
    // explicit scan gives a targeted, clear failure for the specific pattern
    // (and catches a usage that a future Svelte version might stop warning
    // about while still being deprecated). Comments are stripped so a doc
    // comment that MENTIONS `<svelte:self>` does not falsely match.
    const violators: string[] = [];
    for (const f of files) {
      const code = stripCommentsAndStringsFor(readFileSync(f, "utf8"), f);
      if (/<svelte:self\b/.test(code)) violators.push(relative(process.cwd(), f));
    }
    expect(violators, "`<svelte:self>` is deprecated — use a self-import instead").toEqual([]);
  });

  test("no.svelte file uses `autofocus` (a11y_autofocus — use programmatic focus)", () => {
    // The HTML `autofocus` attribute is flagged by a11y_autofocus; programmatic
    // focus on mount/reveal (an $effect that calls.focus) is the a11y-safe
    // replacement. This explicit scan keeps the rule visible even if a future
    // Svelte version changes the warning code. Comments are stripped so a doc
    // comment that mentions `autofocus` does not falsely match; `\bautofocus\b`
    // does NOT match `autofocusSelect` (no word boundary between the two
    // word chars), so the shared Svelte action is correctly excluded.
    const violators: string[] = [];
    for (const f of files) {
      const code = stripCommentsAndStringsFor(readFileSync(f, "utf8"), f);
      if (/\bautofocus\b/.test(code)) violators.push(relative(process.cwd(), f));
    }
    expect(violators, "`autofocus` is an a11y anti-pattern — focus programmatically instead").toEqual([]);
  });
});
