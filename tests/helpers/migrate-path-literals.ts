/**
 * Migrate prevention guards off hardcoded product-path literals onto the
 * module resolver. For each guard file, every string literal that names a
 * product module's repo-relative path is replaced by a resolver call
 * (`modulePath("base.ts")` or, for a colliding basename,
 * `modulePathIn("server", "base.ts")`).
 *
 * This is a CODEMOD, run once by a writer — not a guard. It is conservative in
 * three ways, each earned by a real hazard:
 *
 *   - It rewrites ONLY a double-quoted string literal whose entire content is
 *     a product path AND that sits in EXPRESSION position. A literal used as
 *     an object-literal KEY (`{ "src/app.ts": sha }`) is quoted-back instead
 *     of replaced — replacing it with a bare call would corrupt the object —
 *     and reported as a KEY so a human decides whether the key should become a
 *     computed property or stay a fixture string.
 *   - It never touches an import specifier (those start with `./`/`../`).
 *   - A literal that resolves to MORE THAN ONE module is scoped with
 *     `modulePathIn(root, base)`; one that resolves to NONE (a planted fixture
 *     name) is left untouched and reported, never guessed.
 *
 * Run from the testing repo root:
 *   node --experimental-strip-types tests/helpers/migrate-path-literals.ts [--write]
 * Without `--write` it only reports (dry run).
 */
import { readFileSync } from "node:fs";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { discoverPreventionGuards, REPO_ROOT } from "../../engine/scripts/tooling/verification/guard-dossier.ts";
import { join } from "node:path";
import { modulePath, modulePathIn, modulePathMatching, productRoots } from "./module-resolver.ts";

const ROOTS = productRoots();

const LITERAL =
  /"((?:server|engine\/src|engine\/scripts|src)\/[a-z0-9][a-z0-9./-]*\.(?:ts|mts|cts|mjs|svelte))"/g;

/** The resolver call for a literal, or null when it must not be rewritten. */
function replacement(full: string): string | null {
  const base = full.split("/").pop()!;
  try {
    // PREFERRED: resolve by bare basename. The name survives a move, so the
    // migrated guard carries NO path segments and never needs re-pointing.
    modulePath(base);
    return `modulePath(${JSON.stringify(base)})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ambiguous")) {
      // The basename collides across the tree. Fall back to the literal's own
      // full path as a UNIQUE fragment — this still resolves the right module
      // and refuses loudly if it ever stops being unique, but it does carry
      // the location, so it is the exception rather than the rule.
      try {
        modulePathMatching(full);
        return `modulePathMatching(${JSON.stringify(full)})`;
      } catch {
        return null; // not unique even as a full path — leave for a human
      }
    }
    return null; // absent / a planted fixture — leave for a human
  }
}

/**
 * Is the match at `index` in OBJECT-KEY position? A key is a string literal
 * followed (after optional whitespace) by a `:`. In that position a bare
 * expression is a syntax error, so the literal is left alone and reported.
 */
function isObjectKey(source: string, index: number, length: number): boolean {
  let i = index + length;
  while (i < source.length && /\s/.test(source[i]!)) i += 1;
  return source[i] === ":";
}

/** Ensure the file imports what the replacements reference. */
function ensureImport(source: string, names: readonly string[]): string {
  const needed = names.filter((n) => new RegExp(`\\b${n}\\(`).test(source));
  if (needed.length === 0) return source;
  const importLine =
    /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/helpers\/module-resolver\.ts["'];?/;
  const existing = source.match(importLine);
  if (existing !== null) {
    const have = new Set(existing[1]!.split(",").map((s) => s.trim()).filter(Boolean));
    const merged = [...new Set([...have, ...needed])].sort();
    return source.replace(
      importLine,
      `import { ${merged.join(", ")} } from "../helpers/module-resolver.ts";`,
    );
  }
  // Insert after the END of the last complete import statement. An import
  // statement may span lines (`import {\n  a,\n} from "…";`), so the anchor is
  // the `from "…";` terminator, not a line that merely starts with `import`.
  const importStmt = /^import\s[\s\S]*?from\s*["'][^"']*["'];?\s*$/gm;
  let last: RegExpExecArray | null = null;
  for (const m of source.matchAll(importStmt)) last = m;
  const line = `import { ${[...needed].sort().join(", ")} } from "../helpers/module-resolver.ts";\n`;
  if (last !== null && last.index !== undefined) {
    const insertAt = last.index + last[0].length;
    return source.slice(0, insertAt) + "\n" + line + source.slice(insertAt).replace(/^\n+/, "");
  }
  return line + source;
}

const write = process.argv.includes("--write");
const changed: string[] = [];
const scoped: string[] = [];
const keys: string[] = [];
const skipped: string[] = [];

// WEB ESTATE ONLY. The engine's own prevention guards (`engine/test/…`) run
// under a different runner with cwd=`engine/`, where `src/…` names the
// engine's source — a different resolution convention this codemod must not
// touch. This migrates the web (vitest) guards the resolver serves.
const webGuards = discoverPreventionGuards().filter((g) =>
  g.startsWith("tests/prevention/"),
);

for (const guard of webGuards) {
  if (guard.endsWith("module-resolver.test.ts")) continue;
  if (guard.endsWith("module-path-literal-owner.test.ts")) continue;
  const abs = join(REPO_ROOT, guard);
  const source = readFileSync(abs, "utf8");
  let touched = false;
  let next = "";
  let cursor = 0;
  for (const match of source.matchAll(LITERAL)) {
    const index = match.index!;
    const whole = match[0];
    const path = match[1]!;
    next += source.slice(cursor, index);
    cursor = index + whole.length;
    if (isObjectKey(source, index, whole.length)) {
      keys.push(`${guard}: ${path}`);
      next += whole; // leave the key; a human decides
      continue;
    }
    const expr = replacement(path);
    if (expr === null) {
      skipped.push(`${guard}: ${path}`);
      next += whole;
      continue;
    }
    if (expr.startsWith("modulePathMatching")) scoped.push(`${guard}: ${path} → ${expr}`);
    touched = true;
    next += expr;
  }
  next += source.slice(cursor);
  if (touched) {
    next = ensureImport(next, ["modulePath", "modulePathIn", "modulePathMatching"]);
    changed.push(guard);
    if (write) {
      // The shared write primitive, so the checkout write door covers it.
      const result = atomicWriteFile(abs, next);
      if (!result.success) throw new Error(`could not write ${abs}: ${result.reason ?? "unknown"}`);
    }
  }
}

console.log(`web guards scanned: ${webGuards.length}`);
console.log(`guards to change: ${changed.length}`);
console.log(`scoped (ambiguous basename): ${scoped.length}`);
console.log(`object keys left for review: ${keys.length}`);
console.log(`skipped (planted/absent fixture): ${skipped.length}`);
if (!write) console.log("\nDRY RUN — pass --write to apply");
