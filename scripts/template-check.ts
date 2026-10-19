/**
 * THE SVELTE TEMPLATE CHECK — the tool that reads the half of this codebase
 * `tsc` cannot see.
 *
 * ── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 *
 * `tsc --noEmit` does not read Svelte templates. Everything between `{` and
 * `}` in a `.svelte` file — every prop passed to a component, every binding,
 * every piece of template logic — was checked by NO tool in this project.
 * "Typecheck is clean" was therefore a far narrower claim than it read as.
 *
 * It is not a theoretical hole. The editor room's HTML view was dead on
 * arrival because `FilePane` mounted `ArtifactFrame` WITHOUT its required
 * `frameKey` prop, so `frameKey.length` threw on every single mount. That
 * room shipped with 142 mechanical tests and a green typecheck, and was
 * broken the first time a human opened it. A missing required prop is a
 * runtime error and nothing else — until this runs.
 *
 * ── WHY IT IS NOT SIMPLY `npx svelte-check` ────────────────────────────────
 *
 * This project is on TypeScript 7 — the native (Go) compiler. Its npm package
 * exports `{ version, versionMajorMinor }` and nothing else: there is no
 * `ts.sys`, no `ts.createProgram`, no JavaScript compiler API at all. The
 * whole svelte-language-tools stack is built on the TypeScript 5.x JS API, so
 * `svelte-check` dies on its first line (`ts.sys.useCaseSensitiveFileNames`
 * of `undefined`) against it.
 *
 * TypeScript 5.9.3 is therefore installed ALONGSIDE 7, under the npm alias
 * `typescript5`, purely to drive this checker. It never compiles the product:
 * `npm run typecheck:client` and `typecheck:server` still run the real
 * `tsc` (7), and the alias is not on any import path. Two versions cannot be
 * installed under one name, and `overrides` cannot nest a PEER dependency
 * (npm refuses: peers must resolve at the installing level), so the alias
 * plus the redirect below is the arrangement that keeps everything inside
 * ONE `npm install` — which matters more than it looks: a tool-local
 * `node_modules` would be silently skipped by `npm ci`, and a check that is
 * not running is indistinguishable from a check that passes.
 *
 * `svelte-check` loads TypeScript exactly once, through one CJS
 * `require('typescript')` in its own entry module, in this process. So the
 * redirect is one resolver hook over one specifier, and its blast radius is
 * this process.
 *
 * ── THE SELF-CHECK IS THE POINT ────────────────────────────────────────────
 *
 * Every failure mode here (missing alias, redirect not applied, wrong TS
 * loaded) would otherwise present as "no errors found" — a green result from
 * a tool that never looked at anything. So the version actually loaded is
 * asserted BEFORE the checker runs, and a mismatch exits non-zero saying so.
 */

import { createRequire } from "node:module";
import Module from "node:module";

const require = createRequire(import.meta.url);

/** The alias the redirect points at, and the major it must resolve to. */
const TS_ALIAS = "typescript5";
const REQUIRED_TS_MAJOR = "5";

function fail(message: string): never {
  process.stderr.write(`[template-check] ${message}\n`);
  process.exit(1);
}

// ── 1. The alias must exist, and must really be TypeScript 5 ───────────────

let aliasVersion: string;
try {
  aliasVersion = require(`${TS_ALIAS}/package.json`).version as string;
} catch {
  fail(
    `the "${TS_ALIAS}" devDependency is missing. It is the npm alias for ` +
      `typescript@5 that drives svelte-check (this project's own TypeScript ` +
      `is 7, whose package exposes no JS compiler API). Run: ` +
      `npm i -D "${TS_ALIAS}@npm:typescript@5.9.3"`,
  );
}
if (!aliasVersion.startsWith(`${REQUIRED_TS_MAJOR}.`)) {
  fail(
    `"${TS_ALIAS}" resolved to TypeScript ${aliasVersion}, but svelte-check ` +
      `needs the ${REQUIRED_TS_MAJOR}.x JavaScript compiler API.`,
  );
}

// ── 2. Redirect the ONE specifier svelte-check loads TypeScript through ────

type ResolveFilename = (this: unknown, request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolve = moduleInternals._resolveFilename;
let redirects = 0;
moduleInternals._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === "typescript") {
    redirects += 1;
    return originalResolve.call(this, TS_ALIAS, ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};

// ── 3. Prove the redirect actually took, before trusting any verdict ───────

const loaded = require("typescript") as { version?: string; sys?: unknown };
if (redirects === 0) {
  fail("the module redirect did not fire — svelte-check would load TypeScript 7 and die.");
}
if (loaded.version !== aliasVersion || typeof loaded.sys !== "object") {
  fail(
    `require("typescript") produced version ${String(loaded.version)} ` +
      `(sys: ${typeof loaded.sys}), not the aliased ${aliasVersion}. Refusing to ` +
      `run, because a checker with the wrong TypeScript reports "no errors" ` +
      `whether or not there are any.`,
  );
}

// ── 4. Hand off to svelte-check's own CLI ──────────────────────────────────

// Its `bin` shim is a one-line `require('../dist/src/index.js')`, and the CLI
// reads `process.argv` itself — so argv is shaped as if the bin were invoked
// directly and the entry module is required in this (already-redirected)
// process.
const binPath = require.resolve(`svelte-check/bin/svelte-check`);
process.argv = [process.argv[0]!, binPath, ...process.argv.slice(2)];
require(binPath);
