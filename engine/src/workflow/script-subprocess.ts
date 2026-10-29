/**
 * THE REPOSITORY SCRIPT SUBPROCESS AND THE GENERATOR PROTOCOL — the one way
 * the harness runs a repository script (`runScriptSubprocess`, bounded in CPU
 * work) and reads a generator's one JSON result line (`generatorReport`), and
 * the one kind of arm a repository-root generator is (`repositoryGeneratorArm`,
 * converged by absence in a tree without it). `harness sync`/`check`
 * (harness-commands.ts) and every module below it that must run a generator
 * (the IssueOps record writer, through `roadmap-page.ts`) use these, so no
 * caller imports the harness's dispatcher to reach a generator.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { repositoryToplevel } from "../git/repository-ownership.ts";
import { HarnessError, INPUT_ERROR_CODE, InputError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { boundedEnding, type SubprocessBounds } from "../process/subprocess-bounds.ts";
import { runCpuBounded } from "../process/supervised-run.ts";
import { configuredSubprocessBounds } from "./workflow-config.ts";

/**
 * ONE KIND OF ARM: a repository-root generator (the runtime must not import
 * it) run as a subprocess speaking the one generator protocol. A tree without
 * the generator (a product-only tree) is converged by absence.
 */
export async function repositoryGeneratorArm(root: string, relativeGenerator: string, args: (repositoryRoot: string) => readonly string[], label: string, code: string): Promise<DecisionIndexArm> {
  const absent = deepFreeze({ status: "absent" as const, converged: true, changed: [] });
  const repositoryRoot = repositoryToplevel(root, "directory");
  if (repositoryRoot === undefined) return absent;
  const generator = resolve(repositoryRoot, relativeGenerator);
  if (!existsSync(generator)) return absent;
  const report = await generatorReport<"current" | "regenerated" | "stale">(root, generator, args(repositoryRoot), label, code);
  return deepFreeze({ status: report.status, converged: report.allCurrent, changed: report.changed });
}

/**
 * THE ONE PROTOCOL of a builder-layer generator run as a subprocess (the
 * runtime must not import the builder layer): ONE JSON line, the LAST one
 * (`runScriptSubprocess` hands back the last non-empty stdout line, so a line
 * an import printed before it is not the answer), `{ allCurrent, status,
 * changed, … }`. A generator that printed nothing, or no JSON last, or
 * another shape, judged nothing: typed `code`, never a silent "current" and
 * never an untyped SyntaxError (wf-del2-correctness NEW-11).
 */
export async function generatorReport<Status extends string>(root: string, generator: string, args: readonly string[], label: string, code: string): Promise<Readonly<{ allCurrent: boolean; status: Status; changed: readonly string[] } & Record<string, unknown>>> {
  const answer = await runScriptSubprocess(root, generator, args);
  let parsed: { allCurrent: boolean; status: Status; changed: readonly string[] } & Record<string, unknown>;
  try {
    // A failed run's printed result still names what is stale; it is never all-current (below).
    parsed = JSON.parse(answer.ok ? answer.payload : answer.printed) as typeof parsed;
  } catch {
    throw new HarnessError(`${label} ${generator} printed no result line (its last line is not the JSON result)`, code);
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.allCurrent !== "boolean" || !Array.isArray(parsed.changed)) {
    throw new HarnessError(`${label} ${generator} printed a result of another shape (no allCurrent flag or changed list)`, code);
  }
  // Current only from a clean exit: a generator that exited non-zero is never all-current, whatever it printed.
  return answer.ok ? parsed : { ...parsed, allCurrent: false };
}

/**
 * What a script subprocess answered: its stdout payload (the final non-empty
 * line, or the whole of it with `fullOutput`), and whether it EXITED CLEAN
 * (status 0). A verdict counts only from a clean exit: a non-zero exit is a
 * failure whatever it printed — `--check`-style commands exit 1 on drift
 * with a payload that says why, which a caller may read for its message,
 * never as a pass. A DISCRIMINATED UNION, so the type checker refuses any
 * read of a payload outside the clean branch: only `ok: true` has one.
 */
export type ScriptAnswer =
  | Readonly<{ ok: true; payload: string }>
  | Readonly<{
    ok: false;
    /** How it ended, in words (`boundedEnding`): its exit status. */
    ending: string;
    /** What it printed: a failure payload to read for the message, never a verdict (so it is not called `payload`). */
    printed: string;
  }>;

/** A failed answer's printed payload as JSON, for its message; `undefined` when it is not JSON. */
export function printedRecord(answer: Extract<ScriptAnswer, { ok: false }>): Record<string, unknown> | undefined {
  try {
    const record = JSON.parse(answer.printed) as unknown;
    return typeof record === "object" && record !== null ? record as Record<string, unknown> : undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

/**
 * Invoke a repository script (`src/cli.ts`, `scripts/test-inventory.ts`,
 * `scripts/run-tests.ts`,...) as a subprocess and return its
 * {@link ScriptAnswer}. A run that did not finish (a signal, a bound, a
 * spawn error) or left no payload has no answer at all and is thrown, naming
 * how it ended.
 *
 * When `fullOutput` is true, the full stdout (trimmed) is returned instead of
 * just the final non-empty line — for scripts that emit multi-line /
 * pretty-printed JSON (e.g. scripts/build-bundle.ts), where taking only the
 * last line would yield a partial fragment that fails to parse.
 */
/**
 * Does this subprocess line NAME ITS FAILURE, rather than continue a stack?
 *
 * Anchored and contained claims, not a `.*` window: a line either starts with
 * an error name, carries Node's module-loader sentence, or carries an upper-
 * case `ERR_*` code. The old single pattern leaned on two unbounded `.*` runs
 * to find those phrases anywhere in the line, which is the same near-anything
 * gap the proximity guard exists to refuse — and the phrases have no need for
 * it: `Cannot find module` is a substring, and `ERR_*` is lexed where it
 * appears.
 */
function namesSubprocessFailure(line: string): boolean {
  const text = line.trim();
  return /^\w*Error\b/u.test(text)
    || text.includes("Cannot find module")
    || /(?:^|\s)ERR_[A-Z_]+\b/u.test(text);
}

/**
 * The line that names a subprocess failure, not the last line it printed.
 *
 * Node writes the useful sentence FIRST ("Error: Cannot find module …", a
 * syntax error, an uncaught exception name) and a stack + its own version
 * banner after it. Reporting `lines.at(-1)` therefore reported
 * "Node.js v24.20.0" for every such death. Prefer the first error-shaped
 * line, then the first line that is neither a stack frame nor the banner.
 */
function subprocessFailureSummary(lines: readonly string[]): string | undefined {
  const meaningful = lines.find(namesSubprocessFailure)
    ?? lines.find((line) => line.trim().length > 0 && !/^\s+at\s/u.test(line) && !/^Node\.js v/u.test(line.trim()));
  return meaningful?.trim();
}

export async function runScriptSubprocess(
  root: string,
  scriptRelativePath: string,
  args: readonly string[],
  options: Readonly<{ fullOutput?: boolean; bounds?: SubprocessBounds }> = {},
): Promise<ScriptAnswer> {
  const bounds = options.bounds ?? configuredSubprocessBounds();
  const scriptPath = resolve(root, scriptRelativePath);
  // A MISSING SCRIPT IS ITS OWN CAUSE. The subprocess's failure mode would
  // otherwise be Node's module loader: a MODULE_NOT_FOUND stack whose last
  // stderr line is "Node.js v24.20.0", which read as a generic builder
  // failure. Name the file and the root it was resolved against instead.
  if (!existsSync(scriptPath)) {
    throw new InputError(
      `the harness does not contain ${scriptRelativePath} (resolved against ${root}); ` +
        `the file is part of the engine package and the harness root must be that package`,
      INPUT_ERROR_CODE,
    );
  }
  // NO-LOAD-BLOCK L2 (audit A-18): bounded by its WORK through the one bounded run, never by a wall clock a
  // loaded host runs out (src/process/subprocess-bounds.ts; the one wall bound is the hang backstop).
  const run = await runCpuBounded(process.execPath, [scriptPath, ...args], { cwd: root, bounds });
  const stdout = run.stdout.toString("utf8").trim();
  const lines = run.stderr.toString("utf8").trim().split("\n").filter((line) => line.trim().length > 0);
  // A STEP THAT DID NOT FINISH HAS NO VERDICT, WHATEVER IT PRINTED FIRST.
  // Ended by a signal, by a bound (the group's CPU budget, a stall, the hang
  // backstop, the kernel's CPU limit), or never started, its stdout is a
  // fragment of a run that never answered: a `{"fresh":true}` printed before a
  // hang the backstop (or a person) ended once read as a pass, and `harness
  // sync` reported allPassed. Fail closed, naming how it ended.
  if (run.ending !== "exited" || run.signal !== null) {
    const said = subprocessFailureSummary(lines);
    throw new InputError(
      `subprocess ${scriptRelativePath} ended without a status payload: ${boundedEnding(run, bounds)}` +
        `${stdout.length === 0 ? "" : ` (the ${String(stdout.length)} characters it printed on stdout before it ended are not a verdict)`}` +
        `${said === undefined ? "" : `; its stderr says: ${said}`}`,
      run.ending === "hung" || run.ending === "stalled" ? "script_subprocess_hung" : "script_subprocess_unfinished",
    );
  }
  if (stdout.length === 0) {
    // No payload on stdout — a genuine subprocess failure. The scripts
    // report a failure as ONE typed JSON line (`{"error": <code>,
    // "message": …}`) on stderr; that record is the error channel, and it
    // is passed through with its own code and message. It is FOUND, not
    // assumed to be the last line: a runtime warning printed after it
    // (a Node deprecation notice) used to replace the typed refusal with
    // "failed without a status payload: (node:123) Warning: …".
    const typed = typedFailureRecord(lines);
    if (typed !== undefined && run.status !== 0) {
      // The STEP is named as a step, never as a location: `src/cli.ts: <a
      // syntax error in another file>` sent the operator to the wrong file
      // (wf1a-correctness). A location, when there is one, is the
      // refusal's own (e.g. `source_syntax_invalid` names the source file).
      throw new HarnessError(`the ${scriptRelativePath} step failed: ${typed.message}`, typed.code);
    }
    const said = subprocessFailureSummary(lines);
    throw new InputError(
      `subprocess ${scriptRelativePath} ended without a status payload: ${boundedEnding(run, bounds)}${said === undefined ? " (it printed nothing on stderr)" : `; its stderr says: ${said}`}`,
      INPUT_ERROR_CODE,
    );
  }
  const payload = options.fullOutput ? stdout : stdout.split("\n").filter((line) => line.trim().length > 0).at(-1) ?? "";
  // A verdict counts only from a clean exit (#394's union): a non-zero exit is a failure whatever it printed.
  if (run.status === 0) return deepFreeze({ ok: true, payload });
  return deepFreeze({ ok: false, ending: boundedEnding(run, bounds), printed: payload });
}

/** The last stderr line that is a typed failure record (`{"error": <code>, "message": <text>}`), if any. */
function typedFailureRecord(lines: readonly string[]): Readonly<{ code: string; message: string }> | undefined {
  for (const line of lines.toReversed()) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      // Not a record (a warning, a progress line): keep looking.
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    const { error, message, originalCode } = (typeof record === "object" && record !== null ? record : {}) as
      { error?: unknown; message?: unknown; originalCode?: unknown };
    // A nested harness CLI wraps a typed refusal as `harness_command_failed`
    // with the refusal's own code in `originalCode`: pass the original on.
    if (typeof error === "string" && typeof message === "string") return { code: typeof originalCode === "string" ? originalCode : error, message };
  }
  return undefined;
}

/** What a whole-file or block generator arm did (the decision index, the shipped hooks): `changed` is what a write rewrote, or what a check found stale. */
export type DecisionIndexArm = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent";
  converged: boolean;
  changed: readonly string[];
}>;
