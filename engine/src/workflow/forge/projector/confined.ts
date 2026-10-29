/**
 * WHERE `project()` RUNS — a SEPARATE PROCESS under the harness's one
 * confinement owner, so its purity is a KERNEL property and not a convention
 * (github-only §9.0, V-26; src/filesystem/self-protection/confined-run.ts):
 *
 *   - no file but node's own binary and libraries is readable, none writable;
 *   - no socket of any family, no io_uring (the network is refused);
 *   - a CPU-time ceiling, judged by CPU work, and an address-space ceiling;
 *   - no signal to any process (the guardian's seccomp signal refusal);
 *   - no environment;
 *   - the program and its input arrive on stdin; the one answer leaves on stdout.
 *
 * {@link linkProgram} turns the declared pure modules into that one program:
 * each module's TypeScript types stripped, each relative import rewritten to
 * the linked module's `data:` URL, and any specifier outside the declared set
 * — a bare name, a `node:` built-in, a relative file not declared — refused
 * typed (`projection_import_refused`) before anything runs. A module that
 * still reaches for the host at run time (a dynamic `import("node:fs")`,
 * `fetch`) meets the kernel: the read, the write or the connect is refused,
 * and the projection is `projection_impure`. The clock cannot be refused by
 * any kernel boundary (the vDSO): `projection.ts` runs every projection twice
 * and refuses two different answers (`projection_nondeterministic`).
 *
 * Each refusal is typed: `projection_confinement_refused` (the guardian
 * cannot confine on this host — never an unconfined run), `projection_impure`,
 * `projection_import_refused`, `projection_cpu_exhausted`,
 * `projection_memory_exhausted`, `projection_failed`.
 */
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { engineConfigDocumentPath } from "../../../kernel/config.ts";
import { HarnessError } from "../../../kernel/errors.ts";
import { identityOverlapIndex, resolveLocation } from "../../../filesystem/path-identity.ts";
import { runConfinedNode } from "../../../filesystem/self-protection/confined-run.ts";
import type { KeepOutFacts } from "../../../filesystem/self-protection/keep-out.ts";
import { keyHomeLocation, openStoreRegistry } from "../../../filesystem/self-protection/key-home.ts";
import { DEFAULT_PROJECTION_CPU_SECONDS, DEFAULT_PROJECTION_MEMORY_BYTES } from "../../workflow-config.ts";
import { debugLog } from "../../../shared/debug/debug-system.ts";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * What a confined call runs: `entry`, the ROOTS its modules must lie under,
 * and the function it calls (text in, text out). The modules are never
 * listed by hand: they are the entry's relative-import closure
 * ({@link confinedModules}), so a module the entry comes to import is linked
 * without a second list to keep in step. The link refuses a module outside
 * the roots, and any import that is not relative (a builtin, a package): the
 * program is pure source, and the kernel confinement (V-26) refuses every
 * reach outside its input whatever the source tries.
 */
export type ConfinedModule = Readonly<{
  entry: string;
  roots: readonly string[];
  exportName: string;
}>;

/** Where and how bounded a confined call runs: the harness (its guardian), the host's keep-out facts, the CPU and address-space ceilings. */
export type ProjectorConfinement = Readonly<{
  harnessRoot: string;
  keepOut: Omit<KeepOutFacts, "harnessRoot">;
  cpuSeconds: number;
  memoryBytes: number;
}>;

/** The engine's source and the repository's `shared/` (the one Markdown parser lives there): the roots of the harness's own confined programs. */
const HARNESS_PROGRAM_ROOTS = Object.freeze([SOURCE_ROOT, resolve(SOURCE_ROOT, "..", "..", "shared")]);


/**
 * THE HOST'S CONFINEMENT of a projection run outside a test: the engine at
 * `engineRoot`, the host's own keep-out facts (its configuration document and
 * every store its key home registers) and the default CPU and memory bounds.
 * The roadmap feed and the live proving scenarios both compute through it.
 */
export function hostConfinement(engineRoot: string): ProjectorConfinement {
  return Object.freeze({
    harnessRoot: resolve(engineRoot),
    keepOut: { hostPaths: [engineConfigDocumentPath()], registry: openStoreRegistry(keyHomeLocation()) },
    cpuSeconds: DEFAULT_PROJECTION_CPU_SECONDS,
    memoryBytes: DEFAULT_PROJECTION_MEMORY_BYTES,
  });
}

/** The projection's program: `project.ts`'s `projectText`, and the pure modules it imports. */
export const PROJECTION_PROGRAM: ConfinedModule = Object.freeze({
  entry: join(SOURCE_ROOT, "workflow/forge/projector/project.ts"),
  roots: HARNESS_PROGRAM_ROOTS,
  exportName: "projectText",
});

/** The roadmap feed's program: `roadmap-feed.ts`'s `roadmapFeedText`, and the pure modules it imports (the state owner among them). */
export const ROADMAP_FEED_PROGRAM: ConfinedModule = Object.freeze({
  entry: join(SOURCE_ROOT, "workflow/forge/projector/roadmap-feed.ts"),
  roots: HARNESS_PROGRAM_ROOTS,
  exportName: "roadmapFeedText",
});

/** A static or literal dynamic import's specifier: `from "x"`, `import "x"`, `import("x")`. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"'\n]+)\2/gu;

/** Every module of `module`'s program, linked: its path and its `data:` URL (types stripped, relative imports rewritten). */
function linkModules(module: ConfinedModule): ReadonlyMap<string, string> {
  // Containment is decided by IDENTITY (the one path-identity owner), never by a path's spelling.
  const identity = identityOverlapIndex();
  const roots = module.roots.map((root) => resolveLocation(resolve(root), "a confined program's root"));
  const urls = new Map<string, string>();
  const refuse = (message: string): never => { throw new HarnessError(`projection_import_refused: ${message}`, "projection_import_refused"); };
  const link = (path: string, chain: readonly string[]): string => {
    const known = urls.get(path);
    if (known !== undefined) return known;
    if (!roots.some((root) => identity.atOrUnder(resolveLocation(path, "a confined program's module"), root))) refuse(`${path} (imported by ${chain.at(-1) ?? "the entry"}) is outside the confined program's roots (${roots.join(", ")})`);
    if (chain.includes(path)) refuse(`${path} imports itself through ${chain.join(" → ")}`);
    const code = stripTypeScriptTypes(readFileSync(path, "utf8")).replace(SPECIFIER, (_whole, lead: string, quote: string, specifier: string) => {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) refuse(`${specifier} (imported by ${path}) is not a module of the confined program`);
      return `${lead}${quote}${link(resolve(dirname(path), specifier), [...chain, path])}${quote}`;
    });
    const url = `data:text/javascript;base64,${Buffer.from(code, "utf8").toString("base64")}`;
    urls.set(path, url);
    return url;
  };
  link(resolve(module.entry), []);
  return urls;
}

/** The modules of `module`'s program: the entry's relative-import closure, each under its roots (a refusal otherwise). */
export function confinedModules(module: ConfinedModule): readonly string[] {
  return [...linkModules(module).keys()];
}

/**
 * The one program for `module` and `input`: every module of the program
 * linked into a `data:` URL, and a loader that calls `exportName(input)` and
 * writes its text answer to stdout.
 */
function linkProgram(module: ConfinedModule, input: string): string {
  const entry = linkModules(module).get(resolve(module.entry))!;
  const refuse = (message: string): never => { throw new HarnessError(`projection_import_refused: ${message}`, "projection_import_refused"); };
  const name = module.exportName;
  if (!/^[A-Za-z_$][\w$]*$/u.test(name)) refuse(`${name} is not an export name`);
  return [
    `import { ${name} } from ${JSON.stringify(entry)};`,
    `let answer;`,
    `try { answer = ${name}(${JSON.stringify(input)}); }`,
    `catch (error) { process.stderr.write("projection_failed: " + (error && error.code ? error.code + ": " : "") + String(error && error.message !== undefined ? error.message : error) + "\\n"); process.exit(5); }`,
    `if (typeof answer !== "string") { process.stderr.write("projection_failed: ${name} answered " + typeof answer + ", not text\\n"); process.exit(5); }`,
    // Exit only once the whole answer is written: a pipe write may still be pending when write() returns.
    `process.stdout.write(answer, (error) => process.exit(error ? 5 : 0));`,
  ].join("\n");
}

/** `module.exportName(input)` computed in its confined process; its text answer, or a typed refusal. */
export function confinedCall(module: ConfinedModule, input: string, confinement: ProjectorConfinement): string {
  const result = runConfinedNode({ harnessRoot: confinement.harnessRoot, keepOut: confinement.keepOut, program: linkProgram(module, input), cpuSeconds: confinement.cpuSeconds, memoryBytes: confinement.memoryBytes });
  if (result.status === "ok") return result.stdout;
  const fail = (code: string, message: string): never => {
    debugLog("forge", "warn", `confined ${module.exportName} refused: ${code}: ${message}`, () => ({ entry: module.entry }));
    throw new HarnessError(`${code}: ${message}`, code);
  };
  if (result.status === "refused") return fail("projection_confinement_refused", `${result.code}: ${result.message}`);
  if (result.signal === "SIGKILL" || result.signal === "SIGXCPU") return fail("projection_cpu_exhausted", `the program spent its ${String(confinement.cpuSeconds)} CPU seconds and the kernel ended it (${result.signal})`);
  // An allocation the address-space ceiling refused: node reports it and ends (an abort, or a caught allocation failure).
  if (result.signal === "SIGABRT" || /out of memory|allocation failed|\bENOMEM\b/iu.test(result.stderr)) return fail("projection_memory_exhausted", `the program reached its ${String(confinement.memoryBytes)}-byte address-space ceiling`);
  // The line that names the failure: the boundary's EACCES/EPERM, else the error node printed, else its last word.
  const lines = result.stderr.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const reason = lines.find((line) => /\b(?:EACCES|EPERM)\b/u.test(line)) ?? lines.find((line) => /(?:^projection_|Error\b)/u.test(line)) ?? lines.at(-1) ?? "";
  // The boundary answered EACCES/EPERM: the program reached for a file or the network it is not given.
  if (/\b(?:EACCES|EPERM)\b/u.test(result.stderr)) return fail("projection_impure", reason);
  return fail("projection_failed", reason || `the program ended with status ${String(result.exitCode)}`);
}
